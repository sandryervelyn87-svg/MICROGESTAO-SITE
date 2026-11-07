from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import smtplib
import ssl
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
SCHEMA_PATH = APP_DIR.parent / "BANCO SQL"
DATABASE_PATH = Path(os.environ.get("MICROGESTAO_DATABASE", APP_DIR / "microgestao.db"))
PASSWORD_ROUNDS = 310_000
SESSION_DAYS = 14
PASSWORD_RESET_MINUTES = 30
MAX_REQUEST_BYTES = 64 * 1024
PAYMENT_METHODS = {"PIX", "Dinheiro", "Cartão de débito", "Cartão de crédito", "Transferência"}
DATABASE_LOCK = threading.Lock()


class ServiceUnavailableError(Exception):
    pass


@contextmanager
def database():
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with DATABASE_LOCK, database() as connection:
        connection.executescript(schema)
        migrations = {
            "fornecedores": {"categoria": "VARCHAR(60)"},
            "vendas": {"descricao": "VARCHAR(160) NOT NULL DEFAULT 'Venda'"},
            "produtos": {"icone": "VARCHAR(12) NOT NULL DEFAULT '▦'"},
        }
        for table, columns in migrations.items():
            existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
            for name, definition in columns.items():
                if name not in existing:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
        users = connection.execute(
            """SELECT u.id, u.nome, p.id AS profile_id FROM usuarios u
               LEFT JOIN business_profiles p ON p.user_id = u.id"""
        ).fetchall()
        for user in users:
            if user["profile_id"] is None:
                insert_business_profile(connection, user["id"], user["nome"], user["nome"])


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ROUNDS)
    return f"{salt.hex()}:{derived.hex()}"


def password_matches(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, expected_hex = stored_hash.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(expected_hex)
    except ValueError:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ROUNDS)
    return hmac.compare_digest(actual, expected)


def name_initials(name: str) -> str:
    parts = name.strip().split()
    return "".join(part[0] for part in parts[:2]).upper() or "MG"


def insert_business_profile(
    connection: sqlite3.Connection,
    user_id: int,
    owner_name: str,
    business_name: str,
    role: str = "Proprietário(a)",
) -> None:
    connection.execute(
        """INSERT OR IGNORE INTO business_profiles
           (user_id, business_name, owner_name, initials, role)
           VALUES (?, ?, ?, ?, ?)""",
        (user_id, business_name, owner_name, name_initials(owner_name), role),
    )


def create_notification(
    connection: sqlite3.Connection,
    user_id: int,
    kind: str,
    title: str,
    description: str,
    entity_key: str | None = None,
) -> None:
    connection.execute(
        """INSERT INTO notifications (user_id, kind, title, description, entity_key)
           VALUES (?, ?, ?, ?, ?)""",
        (user_id, kind, title, description, entity_key),
    )


def sync_stock_notifications(connection: sqlite3.Connection, user_id: int) -> None:
    products = connection.execute(
        """SELECT id, nome, quantidade, estoque_minimo FROM produtos WHERE usuario_id = ?""",
        (user_id,),
    ).fetchall()
    active_keys: set[str] = set()
    for product in products:
        if product["quantidade"] > product["estoque_minimo"]:
            continue
        kind = "out_of_stock" if product["quantidade"] == 0 else "low_stock"
        entity_key = f"stock:{product['id']}:{kind}"
        active_keys.add(entity_key)
        description = (
            f"{product['nome']} está sem unidades no estoque."
            if kind == "out_of_stock"
            else f"{product['nome']} tem {product['quantidade']} unidade(s); mínimo {product['estoque_minimo']}."
        )
        connection.execute(
            """INSERT INTO notifications (user_id, kind, title, description, entity_key)
               SELECT ?, ?, ?, ?, ?
               WHERE NOT EXISTS (
                   SELECT 1 FROM notifications WHERE user_id = ? AND entity_key = ?
               )""",
            (
                user_id,
                kind,
                "Produto esgotado" if kind == "out_of_stock" else "Estoque baixo",
                description,
                entity_key,
                user_id,
                entity_key,
            ),
        )
    existing = connection.execute(
        """SELECT id, entity_key FROM notifications WHERE user_id = ?
           AND kind IN ('low_stock', 'out_of_stock')""",
        (user_id,),
    ).fetchall()
    connection.executemany(
        "DELETE FROM notifications WHERE id = ?",
        [(row["id"],) for row in existing if row["entity_key"] not in active_keys],
    )


def require_date(value: object, field: str) -> str:
    result = require_text(value, field, 10)
    try:
        parsed = datetime.strptime(result, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"Informe uma data válida para {field}.") from None
    if parsed.strftime("%Y-%m-%d") != result:
        raise ValueError(f"Informe uma data válida para {field}.")
    return result


def password_reset_settings() -> tuple[str, str, int, str, str, str, str]:
    public_url = os.environ.get("MICROGESTAO_PUBLIC_URL", "").strip().rstrip("/")
    parsed_url = urlparse(public_url)
    if (
        parsed_url.scheme not in {"http", "https"}
        or not parsed_url.hostname
        or parsed_url.username
        or parsed_url.password
        or parsed_url.path not in {"", "/"}
        or parsed_url.query
        or parsed_url.fragment
        or (parsed_url.scheme != "https" and parsed_url.hostname not in {"localhost", "127.0.0.1"})
    ):
        raise ServiceUnavailableError(
            "A recuperação de senha ainda não está configurada pelo responsável pelo sistema."
        )

    host = os.environ.get("MICROGESTAO_SMTP_HOST", "").strip()
    username = os.environ.get("MICROGESTAO_SMTP_USER", "").strip()
    password = os.environ.get("MICROGESTAO_SMTP_PASSWORD", "")
    sender = os.environ.get("MICROGESTAO_SMTP_FROM", username).strip()
    security = os.environ.get("MICROGESTAO_SMTP_SECURITY", "starttls").strip().lower()
    try:
        port = int(os.environ.get("MICROGESTAO_SMTP_PORT", "587"))
    except ValueError:
        raise ServiceUnavailableError(
            "A recuperação de senha ainda não está configurada pelo responsável pelo sistema."
        ) from None
    if not host or not username or not password or not sender or not 1 <= port <= 65535 or security not in {"starttls", "ssl"}:
        raise ServiceUnavailableError(
            "A recuperação de senha ainda não está configurada pelo responsável pelo sistema."
        )
    return public_url, host, port, username, password, sender, security


def send_password_reset_email(
    recipient: str,
    name: str,
    reset_url: str,
    settings: tuple[str, str, int, str, str, str, str],
) -> None:
    _, host, port, username, password, sender, security = settings
    message = EmailMessage()
    message["Subject"] = "Redefinição de senha do MicroGestão"
    message["From"] = sender
    message["To"] = recipient
    message.set_content(
        f"Olá, {name}!\n\n"
        "Recebemos um pedido para redefinir a senha da sua conta MicroGestão. "
        "Use o link abaixo em até 30 minutos:\n\n"
        f"{reset_url}\n\n"
        "Se você não pediu essa alteração, ignore este e-mail. Sua senha continuará a mesma."
    )
    context = ssl.create_default_context()
    try:
        if security == "ssl":
            with smtplib.SMTP_SSL(host, port, timeout=15, context=context) as smtp:
                smtp.login(username, password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=15) as smtp:
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
                smtp.login(username, password)
                smtp.send_message(message)
    except (OSError, smtplib.SMTPException) as error:
        raise ServiceUnavailableError(
            "Não foi possível enviar o e-mail de recuperação agora. Tente novamente mais tarde."
        ) from error


def require_text(value: object, field: str, maximum: int, *, optional: bool = False) -> str:
    if optional and value in (None, ""):
        return ""
    if not isinstance(value, str):
        raise ValueError(f"Informe {field}.")
    value = value.strip()
    if not value:
        raise ValueError(f"Informe {field}.")
    if len(value) > maximum:
        raise ValueError(f"{field.capitalize()} deve ter no máximo {maximum} caracteres.")
    return value


def require_integer(value: object, field: str, minimum: int = 0) -> int:
    if isinstance(value, bool):
        raise ValueError(f"Informe um valor válido para {field}.")
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"Informe um valor válido para {field}.") from None
    if str(value).strip() != str(result) or result < minimum:
        raise ValueError(f"{field.capitalize()} deve ser um número inteiro igual ou maior que {minimum}.")
    return result


def require_money(value: object, field: str) -> Decimal:
    try:
        result = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise ValueError(f"Informe um valor válido para {field}.") from None
    if not result.is_finite() or result < 0 or result > Decimal("99999999.99"):
        raise ValueError(f"{field.capitalize()} deve estar entre R$ 0,00 e R$ 99.999.999,99.")
    return result


class MicroGestaoHandler(BaseHTTPRequestHandler):
    server_version = "MicroGestao/1.0"

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.log_date_time_string()} - {format % args}")

    def send_json(self, status: int, payload: object, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status: int, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        if headers:
            for name, value in headers.items():
                self.send_header(name, value)
        self.end_headers()

    def read_json(self) -> dict[str, object]:
        length_header = self.headers.get("Content-Length", "0")
        try:
            length = int(length_header)
        except ValueError:
            raise ValueError("Tamanho da requisição inválido.") from None
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("O conteúdo enviado está vazio ou excede o limite permitido.")
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ValueError("O conteúdo precisa estar no formato JSON.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Não foi possível ler os dados enviados.") from None
        if not isinstance(payload, dict):
            raise ValueError("Os dados enviados estão inválidos.")
        return payload

    def request_path(self) -> str:
        return unquote(urlparse(self.path).path)

    def request_query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def cookie(self, name: str) -> str | None:
        cookie_header = self.headers.get("Cookie", "")
        for item in cookie_header.split(";"):
            key, separator, value = item.strip().partition("=")
            if separator and key == name:
                return value
        return None

    def current_user(self) -> sqlite3.Row | None:
        token = self.cookie("mg_session")
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        with database() as connection:
            return connection.execute(
                """SELECT u.id, u.nome, u.email
                   FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
                   WHERE s.token_hash = ? AND s.expira_em > ?""",
                (token_hash, now),
            ).fetchone()

    def require_user(self) -> sqlite3.Row:
        user = self.current_user()
        if user is None:
            raise PermissionError("Sua sessão expirou. Entre novamente.")
        return user

    @staticmethod
    def profile_payload(profile: sqlite3.Row | None) -> dict[str, object] | None:
        if profile is None:
            return None
        data = dict(profile)
        try:
            data["preferences"] = json.loads(data.get("preferences", "{}"))
        except json.JSONDecodeError:
            data["preferences"] = {}
        return data

    def set_session_cookie(self, token: str, max_age: int) -> dict[str, str]:
        return {
            "Set-Cookie": f"mg_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        }

    def handle_error(self, error: Exception) -> None:
        if isinstance(error, PermissionError):
            self.send_json(401, {"error": str(error)})
        elif isinstance(error, ValueError):
            self.send_json(400, {"error": str(error)})
        elif isinstance(error, ServiceUnavailableError):
            self.send_json(503, {"error": str(error)})
        elif isinstance(error, sqlite3.IntegrityError):
            message = str(error)
            if "UNIQUE constraint failed" in message:
                message = "Já existe um cadastro com esses dados."
            elif "FOREIGN KEY constraint failed" in message:
                message = "Este registro está vinculado a outros dados e não pode ser removido."
            else:
                message = "Os dados não puderam ser salvos."
            self.send_json(409, {"error": message})
        else:
            raise error

    def do_GET(self) -> None:
        path = self.request_path()
        if path.startswith("/api/"):
            try:
                self.get_api(path)
            except (PermissionError, ValueError, sqlite3.IntegrityError, ServiceUnavailableError) as error:
                self.handle_error(error)
            return
        self.serve_static(path)

    def get_api(self, path: str) -> None:
        if path == "/api/session":
            user = self.current_user()
            user_data = None
            if user is not None:
                with database() as connection:
                    profile = connection.execute(
                        """SELECT business_name, owner_name, initials, role, preferences
                           FROM business_profiles WHERE user_id = ?""",
                        (user["id"],),
                    ).fetchone()
                user_data = {
                    "id": user["id"],
                    "name": user["nome"],
                    "email": user["email"],
                    "profile": self.profile_payload(profile),
                }
            self.send_json(200, {"authenticated": user is not None, "user": user_data})
            return
        user = self.require_user()
        user_id = user["id"]
        with database() as connection:
            if path == "/api/profile":
                profile = connection.execute(
                    """SELECT business_name, owner_name, initials, role, preferences
                       FROM business_profiles WHERE user_id = ?""",
                    (user_id,),
                ).fetchone()
                if profile is None:
                    self.send_json(404, {"error": "Perfil do negócio não encontrado."})
                else:
                    self.send_json(200, self.profile_payload(profile))
            elif path == "/api/dashboard":
                sync_stock_notifications(connection, user_id)
                period = self.request_query().get("period", ["8days"])[0]
                if period not in {"today", "yesterday", "8days", "30days"}:
                    raise ValueError("Selecione um período válido para o gráfico.")
                total = connection.execute(
                    """SELECT COUNT(*) AS product_count,
                              COALESCE(SUM(quantidade * preco_custo), 0) AS stock_value
                       FROM produtos WHERE usuario_id = ?""",
                    (user_id,),
                ).fetchone()
                low_stock = connection.execute(
                    """SELECT p.id, p.nome, p.quantidade, p.estoque_minimo, c.nome AS categoria
                       FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id
                       WHERE p.usuario_id = ? AND p.quantidade <= p.estoque_minimo
                       ORDER BY p.quantidade ASC, p.nome LIMIT 6""",
                    (user_id,),
                ).fetchall()
                sales_today = connection.execute(
                    """SELECT COUNT(*) AS count, COALESCE(SUM(valor_total), 0) AS total
                       FROM vendas WHERE usuario_id = ? AND date(data_venda, 'localtime') = date('now', 'localtime')""",
                    (user_id,),
                ).fetchone()
                sales_yesterday = connection.execute(
                    """SELECT COUNT(*) AS count, COALESCE(SUM(valor_total), 0) AS total
                       FROM vendas WHERE usuario_id = ?
                         AND date(data_venda, 'localtime') = date('now', 'localtime', '-1 day')""",
                    (user_id,),
                ).fetchone()
                expenses_this_month = connection.execute(
                    """SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
                       WHERE user_id = ? AND strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now', 'localtime')""",
                    (user_id,),
                ).fetchone()
                expenses_last_month = connection.execute(
                    """SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
                       WHERE user_id = ? AND strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now', 'localtime', '-1 month')""",
                    (user_id,),
                ).fetchone()
                loss_summary = connection.execute(
                    """SELECT COALESCE(SUM(amount), 0) AS total,
                              COALESCE(SUM(quantity), 0) AS quantity, COUNT(*) AS count
                       FROM losses WHERE user_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')""",
                    (user_id,),
                ).fetchone()
                expense_categories = connection.execute(
                    """SELECT category, SUM(amount) AS total FROM expenses
                       WHERE user_id = ? AND strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now', 'localtime')
                       GROUP BY category ORDER BY total DESC""",
                    (user_id,),
                ).fetchall()
                expense_chart = connection.execute(
                    """SELECT expense_date AS day, SUM(amount) AS total FROM expenses
                       WHERE user_id = ? AND expense_date >= date('now', 'localtime', '-29 days')
                       GROUP BY expense_date ORDER BY expense_date""",
                    (user_id,),
                ).fetchall()
                chart_start = {
                    "today": "date('now', 'localtime')",
                    "yesterday": "date('now', 'localtime', '-1 day')",
                    "8days": "date('now', 'localtime', '-7 days')",
                    "30days": "date('now', 'localtime', '-29 days')",
                }[period]
                sales_chart = connection.execute(
                    f"""SELECT date(data_venda, 'localtime') AS day, SUM(valor_total) AS total
                        FROM vendas WHERE usuario_id = ?
                          AND date(data_venda, 'localtime') >= {chart_start}
                        GROUP BY date(data_venda, 'localtime') ORDER BY day""",
                    (user_id,),
                ).fetchall()
                low_stock_count = connection.execute(
                    """SELECT COUNT(*) FROM produtos
                       WHERE usuario_id = ? AND quantidade <= estoque_minimo""",
                    (user_id,),
                ).fetchone()[0]
                profile = connection.execute(
                    "SELECT business_name, owner_name, initials, role FROM business_profiles WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                recent_sales = connection.execute(
                    """SELECT id, descricao, data_venda, valor_total, forma_pagamento
                       FROM vendas WHERE usuario_id = ? ORDER BY id DESC LIMIT 5""",
                    (user_id,),
                ).fetchall()
                weekly_sales = connection.execute(
                    """SELECT date(data_venda, 'localtime') AS day, SUM(valor_total) AS total
                       FROM vendas
                       WHERE usuario_id = ?
                         AND date(data_venda, 'localtime') >= date('now', 'localtime', '-6 days')
                       GROUP BY date(data_venda, 'localtime')""",
                    (user_id,),
                ).fetchall()
                self.send_json(200, {
                    "profile": dict(profile) if profile else None,
                    "product_count": total["product_count"],
                    "stock_units": connection.execute(
                        "SELECT COALESCE(SUM(quantidade), 0) FROM produtos WHERE usuario_id = ?",
                        (user_id,),
                    ).fetchone()[0],
                    "stock_value": total["stock_value"],
                    "low_stock_count": low_stock_count,
                    "low_stock": [dict(row) for row in low_stock],
                    "sales_today": dict(sales_today),
                    "sales_yesterday": dict(sales_yesterday),
                    "expenses_this_month": expenses_this_month["total"],
                    "expenses_last_month": expenses_last_month["total"],
                    "expense_categories": [dict(row) for row in expense_categories],
                    "expense_chart": [dict(row) for row in expense_chart],
                    "losses_this_month": dict(loss_summary),
                    "sales_chart": [dict(row) for row in sales_chart],
                    "recent_sales": [dict(row) for row in recent_sales],
                    "weekly_sales": [dict(row) for row in weekly_sales],
                })
            elif path == "/api/products":
                rows = connection.execute(
                    """SELECT p.id, p.nome AS name, p.categoria_id AS category_id,
                              c.nome AS category_name, p.quantidade AS quantity,
                              p.preco_custo AS cost_price, p.preco_venda AS sale_price,
                              p.estoque_minimo AS min_stock, p.icone AS icon, p.atualizado_em AS updated_at
                       FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id
                       WHERE p.usuario_id = ? ORDER BY p.nome""",
                    (user_id,),
                ).fetchall()
                self.send_json(200, [dict(row) for row in rows])
            elif path == "/api/losses":
                rows = connection.execute(
                    """SELECT id, product_id, product_name, quantity, amount, reason, created_at
                       FROM losses WHERE user_id = ? ORDER BY created_at DESC, id DESC""",
                    (user_id,),
                ).fetchall()
                self.send_json(200, [dict(row) for row in rows])
            elif path == "/api/expenses":
                rows = connection.execute(
                    """SELECT id, description, category, amount, expense_date
                       FROM expenses WHERE user_id = ? ORDER BY expense_date DESC, id DESC""",
                    (user_id,),
                ).fetchall()
                self.send_json(200, [dict(row) for row in rows])
            elif path == "/api/notifications":
                sync_stock_notifications(connection, user_id)
                rows = connection.execute(
                    """SELECT id, kind, title, description, is_read, created_at
                       FROM notifications WHERE user_id = ? ORDER BY is_read ASC, created_at DESC LIMIT 100""",
                    (user_id,),
                ).fetchall()
                self.send_json(200, {
                    "items": [dict(row) for row in rows],
                    "unread_count": sum(not row["is_read"] for row in rows),
                })
            elif path == "/api/categories":
                rows = connection.execute(
                    "SELECT id, nome AS name FROM categorias WHERE usuario_id = ? ORDER BY nome",
                    (user_id,),
                ).fetchall()
                self.send_json(200, [dict(row) for row in rows])
            elif path == "/api/suppliers":
                rows = connection.execute(
                    """SELECT id, nome_empresa AS company_name, contato_nome AS contact_name,
                              categoria AS category, telefone AS phone, email, observacoes AS notes
                       FROM fornecedores WHERE usuario_id = ? ORDER BY nome_empresa""",
                    (user_id,),
                ).fetchall()
                self.send_json(200, [dict(row) for row in rows])
            elif path == "/api/sales":
                rows = connection.execute(
                    """SELECT v.id, v.descricao AS description, v.data_venda AS created_at, v.valor_total AS total,
                              v.forma_pagamento AS payment_method,
                              (SELECT COUNT(*) FROM itens_venda i WHERE i.venda_id = v.id) AS item_count
                       FROM vendas v WHERE v.usuario_id = ? ORDER BY v.id DESC LIMIT 100""",
                    (user_id,),
                ).fetchall()
                self.send_json(200, [dict(row) for row in rows])
            else:
                self.send_json(404, {"error": "Recurso não encontrado."})

    def do_POST(self) -> None:
        path = self.request_path()
        try:
            payload = self.read_json()
            if path == "/api/register":
                self.register(payload)
            elif path == "/api/login":
                self.login(payload)
            elif path == "/api/profile":
                user = self.require_user()
                self.update_profile(payload, user["id"])
            elif path == "/api/password-reset-request":
                self.request_password_reset(payload)
            elif path == "/api/password-reset":
                self.reset_password(payload)
            elif path == "/api/logout":
                self.logout()
            elif path == "/api/notifications/read-all":
                user = self.require_user()
                with database() as connection:
                    connection.execute(
                        "UPDATE notifications SET is_read = 1 WHERE user_id = ?",
                        (user["id"],),
                    )
                self.send_empty(204)
            elif path.startswith("/api/"):
                user = self.require_user()
                self.create_resource(path, payload, user["id"])
            else:
                self.send_json(404, {"error": "Recurso não encontrado."})
        except (PermissionError, ValueError, sqlite3.IntegrityError, ServiceUnavailableError) as error:
            self.handle_error(error)

    def register(self, payload: dict[str, object]) -> None:
        name = require_text(payload.get("name"), "seu nome", 100)
        email = require_text(payload.get("email"), "seu e-mail", 150).lower()
        password = require_text(payload.get("password"), "uma senha", 128)
        business_name = require_text(
            payload.get("business_name") or f"Negócio de {name.split()[0]}",
            "o nome do negócio",
            120,
        )
        role = require_text(payload.get("role") or "Proprietário(a)", "sua função", 80)
        if "@" not in email or "." not in email.split("@")[-1]:
            raise ValueError("Informe um e-mail válido.")
        if len(password) < 8:
            raise ValueError("A senha precisa ter pelo menos 8 caracteres.")
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).replace(microsecond=0).isoformat()
        with database() as connection:
            cursor = connection.execute(
                "INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)",
                (name, email, password_hash(password)),
            )
            user_id = cursor.lastrowid
            insert_business_profile(connection, user_id, name, business_name, role)
            connection.execute(
                "INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)",
                (token_hash, user_id, expires_at),
            )
        self.send_json(201, {"user": {
            "id": user_id,
            "name": name,
            "email": email,
            "profile": {
                "business_name": business_name,
                "owner_name": name,
                "initials": name_initials(name),
                "role": role,
            },
        }},
                       self.set_session_cookie(token, SESSION_DAYS * 86400))

    def update_profile(self, payload: dict[str, object], user_id: int) -> None:
        owner_name = require_text(payload.get("owner_name"), "o nome do usuário", 100)
        business_name = require_text(payload.get("business_name"), "o nome do negócio", 120)
        role = require_text(payload.get("role"), "a função", 80)
        initials = name_initials(owner_name)
        preferences_value = payload.get("preferences", {})
        if not isinstance(preferences_value, dict):
            raise ValueError("As preferências do negócio estão inválidas.")
        preferences = json.dumps(preferences_value, ensure_ascii=False)
        if len(preferences) > 4000:
            raise ValueError("As preferências excedem o limite permitido.")
        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE usuarios SET nome = ? WHERE id = ?", (owner_name, user_id))
            result = connection.execute(
                """UPDATE business_profiles SET business_name = ?, owner_name = ?, initials = ?,
                          role = ?, preferences = ?, updated_at = CURRENT_TIMESTAMP
                   WHERE user_id = ?""",
                (business_name, owner_name, initials, role, preferences, user_id),
            )
            if result.rowcount == 0:
                insert_business_profile(connection, user_id, owner_name, business_name, role)
            create_notification(
                connection, user_id, "profile_updated", "Perfil atualizado",
                f"Os dados de {business_name} foram atualizados.",
            )
        self.send_json(200, {
            "business_name": business_name,
            "owner_name": owner_name,
            "initials": initials,
            "role": role,
            "preferences": preferences_value,
        })

    def login(self, payload: dict[str, object]) -> None:
        email = require_text(payload.get("email"), "seu e-mail", 150).lower()
        password = require_text(payload.get("password"), "sua senha", 128)
        with database() as connection:
            user = connection.execute(
                "SELECT id, nome, email, senha_hash FROM usuarios WHERE email = ?", (email,)
            ).fetchone()
        if user is None or not password_matches(password, user["senha_hash"]):
            raise ValueError("E-mail ou senha incorretos.")
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).replace(microsecond=0).isoformat()
        with database() as connection:
            connection.execute(
                "INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)",
                (token_hash, user["id"], expires_at),
            )
        with database() as connection:
            profile = connection.execute(
                """SELECT business_name, owner_name, initials, role, preferences
                   FROM business_profiles WHERE user_id = ?""",
                (user["id"],),
            ).fetchone()
        self.send_json(200, {"user": {
            "id": user["id"],
            "name": user["nome"],
            "email": user["email"],
            "profile": self.profile_payload(profile),
        }},
                       self.set_session_cookie(token, SESSION_DAYS * 86400))

    def request_password_reset(self, payload: dict[str, object]) -> None:
        email = require_text(payload.get("email"), "seu e-mail", 150).lower()
        if "@" not in email or "." not in email.split("@")[-1]:
            raise ValueError("Informe um e-mail válido.")

        settings = password_reset_settings()
        with database() as connection:
            user = connection.execute(
                "SELECT id, nome, email FROM usuarios WHERE email = ?", (email,)
            ).fetchone()
        if user is not None:
            token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
            expires_at = (
                datetime.now(timezone.utc) + timedelta(minutes=PASSWORD_RESET_MINUTES)
            ).replace(microsecond=0).isoformat()
            with database() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("DELETE FROM recuperacao_senha WHERE usuario_id = ?", (user["id"],))
                connection.execute(
                    "INSERT INTO recuperacao_senha (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)",
                    (token_hash, user["id"], expires_at),
                )
            reset_url = f"{settings[0]}/?reset={quote(token)}"
            try:
                send_password_reset_email(user["email"], user["nome"], reset_url, settings)
            except ServiceUnavailableError:
                with database() as connection:
                    connection.execute("DELETE FROM recuperacao_senha WHERE token_hash = ?", (token_hash,))
                raise

        self.send_json(200, {
            "message": "Se houver uma conta com esse e-mail, enviaremos um link para redefinir a senha."
        })

    def reset_password(self, payload: dict[str, object]) -> None:
        token = require_text(payload.get("token"), "o link de recuperação", 256)
        password = require_text(payload.get("password"), "uma nova senha", 128)
        if len(password) < 8:
            raise ValueError("A senha precisa ter pelo menos 8 caracteres.")
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            reset = connection.execute(
                """SELECT usuario_id FROM recuperacao_senha
                   WHERE token_hash = ? AND expira_em > ?""",
                (token_hash, now),
            ).fetchone()
            if reset is None:
                raise ValueError("Este link de recuperação expirou ou já foi usado. Solicite outro.")
            connection.execute(
                "UPDATE usuarios SET senha_hash = ? WHERE id = ?",
                (password_hash(password), reset["usuario_id"]),
            )
            connection.execute("DELETE FROM recuperacao_senha WHERE usuario_id = ?", (reset["usuario_id"],))
            connection.execute("DELETE FROM sessoes WHERE usuario_id = ?", (reset["usuario_id"],))

        self.send_json(200, {"message": "Senha redefinida com sucesso. Entre com sua nova senha."})

    def logout(self) -> None:
        token = self.cookie("mg_session")
        if token:
            token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
            with database() as connection:
                connection.execute("DELETE FROM sessoes WHERE token_hash = ?", (token_hash,))
        self.send_empty(204, self.set_session_cookie("", 0))

    def create_resource(self, path: str, payload: dict[str, object], user_id: int) -> None:
        if path == "/api/products":
            product = self.product_values(payload, user_id)
            with database() as connection:
                cursor = connection.execute(
                    """INSERT INTO produtos
                       (usuario_id, categoria_id, nome, quantidade, preco_custo, preco_venda, estoque_minimo, icone)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (user_id, *product),
                )
                sync_stock_notifications(connection, user_id)
                create_notification(connection, user_id, "created", "Produto cadastrado", f"{product[1]} foi adicionado ao estoque.")
                product_id = cursor.lastrowid
            self.send_json(201, {"id": product_id})
        elif path == "/api/categories":
            name = require_text(payload.get("name"), "o nome da categoria", 50)
            with database() as connection:
                cursor = connection.execute(
                    "INSERT INTO categorias (usuario_id, nome) VALUES (?, ?)", (user_id, name)
                )
                create_notification(connection, user_id, "created", "Categoria cadastrada", f"A categoria {name} foi criada.")
            self.send_json(201, {"id": cursor.lastrowid})
        elif path == "/api/suppliers":
            supplier = self.supplier_values(payload)
            with database() as connection:
                cursor = connection.execute(
                    """INSERT INTO fornecedores
                       (usuario_id, nome_empresa, categoria, contato_nome, telefone, email, observacoes)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (user_id, *supplier),
                )
                create_notification(connection, user_id, "created", "Fornecedor cadastrado", f"{supplier[0]} foi adicionado.")
            self.send_json(201, {"id": cursor.lastrowid})
        elif path == "/api/sales":
            self.create_sale(payload, user_id)
        elif path == "/api/losses":
            values = self.loss_values(payload, user_id)
            with database() as connection:
                connection.execute("BEGIN IMMEDIATE")
                if values[1] is not None:
                    changed = connection.execute(
                        """UPDATE produtos SET quantidade = quantidade - ?,
                                  atualizado_em = CURRENT_TIMESTAMP
                           WHERE id = ? AND usuario_id = ? AND quantidade >= ?""",
                        (values[2], values[1], user_id, values[2]),
                    )
                    if changed.rowcount == 0:
                        raise ValueError("Estoque insuficiente para registrar essa perda.")
                cursor = connection.execute(
                    """INSERT INTO losses (user_id, product_id, product_name, quantity, amount, reason)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (user_id, values[1], values[0], values[2], values[3], values[4]),
                )
                create_notification(connection, user_id, "created", "Perda registrada", f"{values[2]} unidade(s) de {values[0]}.")
            self.send_json(201, {"id": cursor.lastrowid})
        elif path == "/api/expenses":
            values = self.expense_values(payload)
            with database() as connection:
                cursor = connection.execute(
                    """INSERT INTO expenses (user_id, description, category, amount, expense_date)
                       VALUES (?, ?, ?, ?, ?)""",
                    (user_id, *values),
                )
                create_notification(connection, user_id, "created", "Gasto registrado", f"{values[0]}: R$ {values[2]}.")
            self.send_json(201, {"id": cursor.lastrowid})
        else:
            self.send_json(404, {"error": "Recurso não encontrado."})

    def product_values(self, payload: dict[str, object], user_id: int) -> tuple[object, ...]:
        name = require_text(payload.get("name"), "o nome do produto", 100)
        category_value = payload.get("category_id")
        category_id = None if category_value in (None, "") else require_integer(category_value, "a categoria", 1)
        quantity = require_integer(payload.get("quantity", 0), "a quantidade")
        cost_price = require_money(payload.get("cost_price", 0), "o preço de custo")
        sale_price = require_money(payload.get("sale_price", 0), "o preço de venda")
        min_stock = require_integer(payload.get("min_stock", 5), "o estoque mínimo")
        icon = require_text(payload.get("icon", "▦"), "o ícone do produto", 12)
        with database() as connection:
            if category_id is not None and not connection.execute(
                "SELECT 1 FROM categorias WHERE id = ? AND usuario_id = ?", (category_id, user_id)
            ).fetchone():
                raise ValueError("Selecione uma categoria válida.")
        return category_id, name, quantity, str(cost_price), str(sale_price), min_stock, icon

    @staticmethod
    def supplier_values(payload: dict[str, object]) -> tuple[str, str, str, str, str, str]:
        company = require_text(payload.get("company_name"), "o nome da empresa", 120)
        category = require_text(payload.get("category"), "a categoria", 60, optional=True)
        contact = require_text(payload.get("contact_name"), "o nome do contato", 100, optional=True)
        phone = require_text(payload.get("phone"), "o telefone", 20, optional=True)
        email = require_text(payload.get("email"), "o e-mail", 100, optional=True)
        notes = require_text(payload.get("notes"), "as observações", 2000, optional=True)
        return company, category, contact, phone, email, notes

    def loss_values(self, payload: dict[str, object], user_id: int) -> tuple[str, int | None, int, str, str]:
        product_id_value = payload.get("product_id")
        product_id = None if product_id_value in (None, "") else require_integer(product_id_value, "o produto", 1)
        quantity = require_integer(payload.get("quantity"), "a quantidade", 1)
        amount = require_money(payload.get("amount"), "o prejuízo")
        reason = require_text(payload.get("reason"), "o motivo", 40)
        if reason not in {"Avaria", "Vencido", "Furto", "Erro de armazenamento"}:
            raise ValueError("Selecione um motivo válido para a perda.")
        name = require_text(payload.get("product_name"), "o nome do produto", 100, optional=product_id is not None)
        with database() as connection:
            if product_id is not None:
                product = connection.execute(
                    "SELECT nome FROM produtos WHERE id = ? AND usuario_id = ?",
                    (product_id, user_id),
                ).fetchone()
                if product is None:
                    raise ValueError("Selecione um produto válido.")
                name = product["nome"]
        return name, product_id, quantity, str(amount), reason

    @staticmethod
    def expense_values(payload: dict[str, object]) -> tuple[str, str, str, str]:
        description = require_text(payload.get("description"), "a descrição", 160)
        category = require_text(payload.get("category"), "a categoria", 40)
        allowed = {"Mercadorias", "Mercado", "Aluguel", "Contas", "Operação", "Outros"}
        if category not in allowed:
            raise ValueError("Selecione uma categoria válida para o gasto.")
        amount = require_money(payload.get("amount"), "o valor")
        expense_date = require_date(payload.get("expense_date"), "a data")
        return description, category, str(amount), expense_date

    def create_sale(self, payload: dict[str, object], user_id: int) -> None:
        if "items" not in payload:
            description = require_text(payload.get("description"), "a descrição da venda", 160)
            amount = require_money(payload.get("amount"), "o valor da venda")
            sale_date = require_date(payload.get("sale_date"), "a data da venda")
            payment_method = require_text(payload.get("payment_method", "PIX"), "a forma de pagamento", 30)
            if payment_method not in PAYMENT_METHODS:
                raise ValueError("Selecione uma forma de pagamento válida.")
            with database() as connection:
                cursor = connection.execute(
                    """INSERT INTO vendas (usuario_id, valor_total, descricao, forma_pagamento, data_venda)
                       VALUES (?, ?, ?, ?, ?)""",
                    (user_id, str(amount), description, payment_method, f"{sale_date} {datetime.now().strftime('%H:%M:%S')}"),
                )
                create_notification(connection, user_id, "created", "Venda registrada", f"{description}: R$ {amount}.")
            self.send_json(201, {"id": cursor.lastrowid, "total": str(amount)})
            return
        lines = payload.get("items")
        if not isinstance(lines, list) or not lines or len(lines) > 100:
            raise ValueError("Adicione ao menos um produto à venda.")
        payment_method = require_text(payload.get("payment_method", "PIX"), "a forma de pagamento", 30)
        if payment_method not in PAYMENT_METHODS:
            raise ValueError("Selecione uma forma de pagamento válida.")
        quantities: dict[int, int] = {}
        for line in lines:
            if not isinstance(line, dict):
                raise ValueError("Os itens da venda estão inválidos.")
            product_id = require_integer(line.get("product_id"), "o produto", 1)
            quantity = require_integer(line.get("quantity"), "a quantidade", 1)
            quantities[product_id] = quantities.get(product_id, 0) + quantity

        with database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            products = {}
            for product_id, quantity in quantities.items():
                product = connection.execute(
                    """SELECT id, nome, quantidade, preco_venda FROM produtos
                       WHERE id = ? AND usuario_id = ?""",
                    (product_id, user_id),
                ).fetchone()
                if product is None:
                    raise ValueError("Um dos produtos selecionados não está disponível.")
                if product["quantidade"] < quantity:
                    raise ValueError(f"Estoque insuficiente para {product['nome']}.")
                products[product_id] = product
            total = sum(
                (Decimal(str(products[product_id]["preco_venda"])) * quantity
                 for product_id, quantity in quantities.items()),
                Decimal("0.00"),
            ).quantize(Decimal("0.01"))
            cursor = connection.execute(
                "INSERT INTO vendas (usuario_id, valor_total, descricao, forma_pagamento) VALUES (?, ?, ?, ?)",
                (user_id, str(total), require_text(payload.get("description", "Venda"), "a descrição", 160), payment_method),
            )
            sale_id = cursor.lastrowid
            for product_id, quantity in quantities.items():
                product = products[product_id]
                price = Decimal(str(product["preco_venda"])).quantize(Decimal("0.01"))
                connection.execute(
                    """INSERT INTO itens_venda
                       (venda_id, produto_id, nome_produto, quantidade, preco_unitario, subtotal)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (sale_id, product_id, product["nome"], quantity, str(price), str(price * quantity)),
                )
                connection.execute(
                    """UPDATE produtos SET quantidade = quantidade - ?,
                              atualizado_em = CURRENT_TIMESTAMP WHERE id = ? AND usuario_id = ?""",
                    (quantity, product_id, user_id),
                )
            create_notification(connection, user_id, "created", "Venda registrada", f"Venda #{sale_id}: R$ {total}.")
            sync_stock_notifications(connection, user_id)
        self.send_json(201, {"id": sale_id, "total": str(total)})

    def do_PUT(self) -> None:
        path = self.request_path()
        try:
            user = self.require_user()
            payload = self.read_json()
            if path == "/api/profile":
                self.update_profile(payload, user["id"])
                return
            parts = path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "api":
                self.send_json(404, {"error": "Recurso não encontrado."})
                return
            resource, raw_id = parts[1], parts[2]
            resource_id = require_integer(raw_id, "o identificador", 1)
            if resource == "products":
                values = self.product_values(payload, user["id"])
                with database() as connection:
                    result = connection.execute(
                        """UPDATE produtos SET categoria_id = ?, nome = ?, quantidade = ?,
                                  preco_custo = ?, preco_venda = ?, estoque_minimo = ?, icone = ?,
                                  atualizado_em = CURRENT_TIMESTAMP
                           WHERE id = ? AND usuario_id = ?""",
                        (*values, resource_id, user["id"]),
                    )
                    if result.rowcount:
                        sync_stock_notifications(connection, user["id"])
                        create_notification(connection, user["id"], "updated", "Produto atualizado", f"{values[1]} foi atualizado.")
            elif resource == "categories":
                name = require_text(payload.get("name"), "o nome da categoria", 50)
                with database() as connection:
                    result = connection.execute(
                        "UPDATE categorias SET nome = ? WHERE id = ? AND usuario_id = ?",
                        (name, resource_id, user["id"]),
                    )
            elif resource == "suppliers":
                values = self.supplier_values(payload)
                with database() as connection:
                    result = connection.execute(
                        """UPDATE fornecedores SET nome_empresa = ?, categoria = ?, contato_nome = ?,
                                  telefone = ?, email = ?, observacoes = ? WHERE id = ? AND usuario_id = ?""",
                        (*values, resource_id, user["id"]),
                    )
                    if result.rowcount:
                        create_notification(connection, user["id"], "updated", "Fornecedor atualizado", f"{values[0]} foi atualizado.")
            elif resource == "losses":
                values = self.loss_values(payload, user["id"])
                with database() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    previous = connection.execute(
                        "SELECT product_id, quantity FROM losses WHERE id = ? AND user_id = ?",
                        (resource_id, user["id"]),
                    ).fetchone()
                    if previous is None:
                        self.send_json(404, {"error": "Cadastro não encontrado."})
                        return
                    if previous["product_id"] is not None:
                        connection.execute(
                            """UPDATE produtos SET quantidade = quantidade + ?,
                                      atualizado_em = CURRENT_TIMESTAMP
                               WHERE id = ? AND usuario_id = ?""",
                            (previous["quantity"], previous["product_id"], user["id"]),
                        )
                    if values[1] is not None:
                        stock_update = connection.execute(
                            """UPDATE produtos SET quantidade = quantidade - ?,
                                      atualizado_em = CURRENT_TIMESTAMP
                               WHERE id = ? AND usuario_id = ? AND quantidade >= ?""",
                            (values[2], values[1], user["id"], values[2]),
                        )
                        if stock_update.rowcount == 0:
                            raise ValueError("Estoque insuficiente para atualizar essa perda.")
                    result = connection.execute(
                        """UPDATE losses SET product_id = ?, product_name = ?, quantity = ?,
                                  amount = ?, reason = ? WHERE id = ? AND user_id = ?""",
                        (values[1], values[0], values[2], values[3], values[4], resource_id, user["id"]),
                    )
                    sync_stock_notifications(connection, user["id"])
                    create_notification(connection, user["id"], "updated", "Perda atualizada", f"{values[0]} foi atualizado.")
            elif resource == "expenses":
                values = self.expense_values(payload)
                with database() as connection:
                    result = connection.execute(
                        """UPDATE expenses SET description = ?, category = ?, amount = ?, expense_date = ?
                           WHERE id = ? AND user_id = ?""",
                        (*values, resource_id, user["id"]),
                    )
                    if result.rowcount:
                        create_notification(connection, user["id"], "updated", "Gasto atualizado", f"{values[0]} foi atualizado.")
            elif resource == "sales":
                description = require_text(payload.get("description"), "a descrição da venda", 160)
                amount = require_money(payload.get("amount"), "o valor da venda")
                sale_date = require_date(payload.get("sale_date"), "a data da venda")
                payment_method = require_text(payload.get("payment_method", "PIX"), "a forma de pagamento", 30)
                if payment_method not in PAYMENT_METHODS:
                    raise ValueError("Selecione uma forma de pagamento válida.")
                with database() as connection:
                    result = connection.execute(
                        """UPDATE vendas SET descricao = ?, valor_total = ?, forma_pagamento = ?,
                                  data_venda = ? WHERE id = ? AND usuario_id = ?""",
                        (description, str(amount), payment_method,
                         f"{sale_date} {datetime.now().strftime('%H:%M:%S')}", resource_id, user["id"]),
                    )
                    if result.rowcount:
                        create_notification(connection, user["id"], "updated", "Venda atualizada", f"{description} foi atualizada.")
            else:
                self.send_json(404, {"error": "Recurso não encontrado."})
                return
            if result.rowcount == 0:
                self.send_json(404, {"error": "Cadastro não encontrado."})
            else:
                self.send_empty(204)
        except (PermissionError, ValueError, sqlite3.IntegrityError, ServiceUnavailableError) as error:
            self.handle_error(error)

    def do_DELETE(self) -> None:
        path = self.request_path()
        try:
            user = self.require_user()
            parts = path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "api":
                self.send_json(404, {"error": "Recurso não encontrado."})
                return
            resource, raw_id = parts[1], parts[2]
            resource_id = require_integer(raw_id, "o identificador", 1)
            tables = {
                "products": ("produtos", "usuario_id"),
                "categories": ("categorias", "usuario_id"),
                "suppliers": ("fornecedores", "usuario_id"),
                "expenses": ("expenses", "user_id"),
                "losses": ("losses", "user_id"),
            }
            table = tables.get(resource)
            if resource == "sales":
                with database() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    sale = connection.execute(
                        "SELECT id FROM vendas WHERE id = ? AND usuario_id = ?",
                        (resource_id, user["id"]),
                    ).fetchone()
                    if sale is None:
                        self.send_json(404, {"error": "Cadastro não encontrado."})
                        return
                    sold_items = connection.execute(
                        """SELECT produto_id, quantidade FROM itens_venda
                           WHERE venda_id = ? AND produto_id IN
                                 (SELECT id FROM produtos WHERE usuario_id = ?)""",
                        (resource_id, user["id"]),
                    ).fetchall()
                    for item in sold_items:
                        connection.execute(
                            """UPDATE produtos SET quantidade = quantidade + ?,
                                      atualizado_em = CURRENT_TIMESTAMP
                               WHERE id = ? AND usuario_id = ?""",
                            (item["quantidade"], item["produto_id"], user["id"]),
                        )
                    connection.execute("DELETE FROM itens_venda WHERE venda_id = ?", (resource_id,))
                    connection.execute("DELETE FROM vendas WHERE id = ? AND usuario_id = ?", (resource_id, user["id"]))
                    create_notification(connection, user["id"], "deleted", "Venda excluída", f"A venda #{resource_id} foi removida.")
                    sync_stock_notifications(connection, user["id"])
                self.send_empty(204)
                return
            if table is None:
                self.send_json(404, {"error": "Recurso não encontrado."})
                return
            with database() as connection:
                if resource == "losses":
                    connection.execute("BEGIN IMMEDIATE")
                    loss = connection.execute(
                        "SELECT product_id, quantity FROM losses WHERE id = ? AND user_id = ?",
                        (resource_id, user["id"]),
                    ).fetchone()
                    if loss is None:
                        self.send_json(404, {"error": "Cadastro não encontrado."})
                        return
                    if loss["product_id"] is not None:
                        connection.execute(
                            """UPDATE produtos SET quantidade = quantidade + ?,
                                      atualizado_em = CURRENT_TIMESTAMP
                               WHERE id = ? AND usuario_id = ?""",
                            (loss["quantity"], loss["product_id"], user["id"]),
                        )
                    create_notification(connection, user["id"], "deleted", "Perda excluída", f"O registro de perda #{resource_id} foi removido.")
                    result = connection.execute(
                        "DELETE FROM losses WHERE id = ? AND user_id = ?", (resource_id, user["id"])
                    )
                    sync_stock_notifications(connection, user["id"])
                else:
                    table_name, user_column = table
                    record = None
                    if resource in {"products", "suppliers", "expenses"}:
                        if resource == "products":
                            record = connection.execute(
                                "SELECT nome AS name FROM produtos WHERE id = ? AND usuario_id = ?",
                                (resource_id, user["id"]),
                            ).fetchone()
                        elif resource == "suppliers":
                            record = connection.execute(
                                "SELECT nome_empresa AS name FROM fornecedores WHERE id = ? AND usuario_id = ?",
                                (resource_id, user["id"]),
                            ).fetchone()
                        else:
                            record = connection.execute(
                                "SELECT description AS name FROM expenses WHERE id = ? AND user_id = ?",
                                (resource_id, user["id"]),
                            ).fetchone()
                    result = connection.execute(
                        f"DELETE FROM {table_name} WHERE id = ? AND {user_column} = ?",
                        (resource_id, user["id"]),
                    )
                    if result.rowcount:
                        sync_stock_notifications(connection, user["id"])
                        create_notification(
                            connection,
                            user["id"],
                            "deleted",
                            "Cadastro excluído",
                            f"{record['name'] if record else 'O registro'} foi removido.",
                        )
            if result.rowcount == 0:
                self.send_json(404, {"error": "Cadastro não encontrado."})
            else:
                self.send_empty(204)
        except (PermissionError, ValueError, sqlite3.IntegrityError, ServiceUnavailableError) as error:
            self.handle_error(error)

    def serve_static(self, path: str) -> None:
        if path == "/":
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            self.send_json(404, {"error": "Página não encontrada."})
            return
        content = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)


class MicroGestaoServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    initialize_database()
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "10000"))
    server = MicroGestaoServer((host, port), MicroGestaoHandler)
    display_host = "127.0.0.1" if host == "0.0.0.0" else host
    print(f"MicroGestão disponível em http://{display_host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando o MicroGestão.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
