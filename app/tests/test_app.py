import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class MicroGestaoApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.original_database_path = server.DATABASE_PATH
        server.DATABASE_PATH = Path(self.temporary_directory.name) / "test.db"
        server.initialize_database()
        self.http_server = server.MicroGestaoServer(("127.0.0.1", 0), server.MicroGestaoHandler)
        self.thread = threading.Thread(target=self.http_server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.http_server.server_port}"
        self.client = self.new_client()

    def tearDown(self):
        self.http_server.shutdown()
        self.http_server.server_close()
        self.thread.join(timeout=2)
        server.DATABASE_PATH = self.original_database_path
        self.temporary_directory.cleanup()

    @staticmethod
    def new_client():
        return build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, client, path, method="GET", payload=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Content-Type": "application/json"} if body is not None else {},
        )
        try:
            with client.open(request, timeout=3) as response:
                content = response.read()
                return response.status, json.loads(content) if content else None
        except HTTPError as error:
            content = error.read()
            return error.code, json.loads(content) if content else None

    def test_server_host_can_be_configured_for_local_network_testing(self):
        with patch.dict(os.environ, {"MICROGESTAO_HOST": "0.0.0.0", "MICROGESTAO_PORT": "8123"}):
            with patch.object(server, "initialize_database") as initialize_database:
                with patch.object(server, "MicroGestaoServer") as server_factory:
                    instance = server_factory.return_value
                    instance.serve_forever.side_effect = KeyboardInterrupt
                    server.main()

        initialize_database.assert_called_once_with()
        server_factory.assert_called_once_with(("0.0.0.0", 8123), server.MicroGestaoHandler)
        instance.server_close.assert_called_once_with()

    def register(self, client, name, email):
        return self.request(client, "/api/register", "POST", {
            "name": name,
            "email": email,
            "password": "senha-forte-123",
        })

    def test_registration_inventory_sale_and_dashboard(self):
        status, account = self.register(self.client, "Ana Silva", "ana@example.com")
        self.assertEqual(status, 201)
        self.assertEqual(account["user"]["name"], "Ana Silva")

        status, category = self.request(self.client, "/api/categories", "POST", {"name": "Papelaria"})
        self.assertEqual(status, 201)
        status, product = self.request(self.client, "/api/products", "POST", {
            "name": "Caderno",
            "category_id": category["id"],
            "quantity": 4,
            "cost_price": 5.50,
            "sale_price": 10,
            "min_stock": 2,
        })
        self.assertEqual(status, 201)

        status, sale = self.request(self.client, "/api/sales", "POST", {
            "items": [{"product_id": product["id"], "quantity": 2}],
            "payment_method": "PIX",
        })
        self.assertEqual(status, 201)
        self.assertEqual(sale["total"], "20.00")

        status, products = self.request(self.client, "/api/products")
        self.assertEqual(status, 200)
        self.assertEqual(products[0]["quantity"], 2)
        self.assertEqual(products[0]["category_name"], "Papelaria")

        status, dashboard = self.request(self.client, "/api/dashboard")
        self.assertEqual(status, 200)
        self.assertEqual(dashboard["sales_today"]["count"], 1)
        self.assertEqual(float(dashboard["sales_today"]["total"]), 20)
        self.assertEqual(dashboard["low_stock"][0]["id"], product["id"])

    def test_sale_rejects_insufficient_stock_without_changing_inventory(self):
        self.register(self.client, "Bruna", "bruna@example.com")
        _, product = self.request(self.client, "/api/products", "POST", {
            "name": "Vela",
            "quantity": 1,
            "cost_price": 2,
            "sale_price": 8,
            "min_stock": 0,
        })
        status, error = self.request(self.client, "/api/sales", "POST", {
            "items": [{"product_id": product["id"], "quantity": 2}],
            "payment_method": "PIX",
        })
        self.assertEqual(status, 400)
        self.assertIn("Estoque insuficiente", error["error"])
        _, products = self.request(self.client, "/api/products")
        self.assertEqual(products[0]["quantity"], 1)
        _, sales = self.request(self.client, "/api/sales")
        self.assertEqual(sales, [])

    def test_accounts_cannot_read_each_others_products(self):
        self.register(self.client, "Carla", "carla@example.com")
        self.request(self.client, "/api/products", "POST", {
            "name": "Produto privado",
            "quantity": 1,
            "cost_price": 1,
            "sale_price": 2,
            "min_stock": 0,
        })

        other_client = self.new_client()
        self.register(other_client, "Dora", "dora@example.com")
        status, products = self.request(other_client, "/api/products")
        self.assertEqual(status, 200)
        self.assertEqual(products, [])

    def test_session_is_cleared_on_logout(self):
        self.register(self.client, "Eva", "eva@example.com")
        self.assertEqual(self.request(self.client, "/api/session")[1]["authenticated"], True)
        self.assertEqual(self.request(self.client, "/api/logout", "POST", {})[0], 204)
        self.assertEqual(self.request(self.client, "/api/session")[1]["authenticated"], False)

    def test_supplier_crud_and_duplicate_category_validation(self):
        self.register(self.client, "Fernanda", "fernanda@example.com")
        status, category = self.request(self.client, "/api/categories", "POST", {"name": "Alimentos"})
        self.assertEqual(status, 201)
        status, error = self.request(self.client, "/api/categories", "POST", {"name": "Alimentos"})
        self.assertEqual(status, 409)
        self.assertIn("Já existe", error["error"])

        status, supplier = self.request(self.client, "/api/suppliers", "POST", {
            "company_name": "Mercado do Bairro",
            "contact_name": "Joana",
            "phone": "11999990000",
            "email": "joana@example.com",
            "notes": "",
        })
        self.assertEqual(status, 201)
        status, rows = self.request(self.client, "/api/suppliers")
        self.assertEqual(status, 200)
        self.assertEqual(rows[0]["company_name"], "Mercado do Bairro")

        status, _ = self.request(self.client, f"/api/suppliers/{supplier['id']}", "PUT", {
            "company_name": "Mercado Central",
            "contact_name": "Joana",
            "phone": "11999990000",
            "email": "joana@example.com",
            "notes": "",
        })
        self.assertEqual(status, 204)
        status, _ = self.request(self.client, f"/api/suppliers/{supplier['id']}", "DELETE")
        self.assertEqual(status, 204)
        status, rows = self.request(self.client, "/api/suppliers")
        self.assertEqual(status, 200)
        self.assertEqual(rows, [])
        titles = {item["title"] for item in self.request(self.client, "/api/notifications")[1]["items"]}
        self.assertIn("Fornecedor atualizado", titles)
        self.assertIn("Cadastro excluído", titles)

    def test_password_reset_changes_password_invalidates_sessions_and_token(self):
        self.register(self.client, "Gabi", "gabi@example.com")
        smtp_environment = {
            "MICROGESTAO_PUBLIC_URL": "http://localhost:8000",
            "MICROGESTAO_SMTP_HOST": "smtp.example.com",
            "MICROGESTAO_SMTP_PORT": "587",
            "MICROGESTAO_SMTP_USER": "mailer@example.com",
            "MICROGESTAO_SMTP_PASSWORD": "test-password",
            "MICROGESTAO_SMTP_FROM": "mailer@example.com",
        }
        with patch.dict(os.environ, smtp_environment), patch.object(server, "send_password_reset_email") as send_email:
            status, response = self.request(
                self.client,
                "/api/password-reset-request",
                "POST",
                {"email": "gabi@example.com"},
            )
        self.assertEqual(status, 200)
        self.assertNotIn("token", response)
        send_email.assert_called_once()
        reset_url = send_email.call_args.args[2]
        token = parse_qs(urlparse(reset_url).query)["reset"][0]

        status, response = self.request(self.client, "/api/password-reset", "POST", {
            "token": token,
            "password": "senha-nova-456",
        })
        self.assertEqual(status, 200)
        self.assertFalse(self.request(self.client, "/api/session")[1]["authenticated"])

        status, error = self.request(self.client, "/api/password-reset", "POST", {
            "token": token,
            "password": "senha-nova-789",
        })
        self.assertEqual(status, 400)
        self.assertIn("já foi usado", error["error"])

        self.assertEqual(self.request(self.client, "/api/login", "POST", {
            "email": "gabi@example.com",
            "password": "senha-forte-123",
        })[0], 400)
        status, account = self.request(self.client, "/api/login", "POST", {
            "email": "gabi@example.com",
            "password": "senha-nova-456",
        })
        self.assertEqual(status, 200)
        self.assertEqual(account["user"]["email"], "gabi@example.com")

    def test_password_reset_request_hides_unknown_accounts(self):
        with patch.dict(os.environ, {
            "MICROGESTAO_PUBLIC_URL": "http://localhost:8000",
            "MICROGESTAO_SMTP_HOST": "smtp.example.com",
            "MICROGESTAO_SMTP_PORT": "587",
            "MICROGESTAO_SMTP_USER": "mailer@example.com",
            "MICROGESTAO_SMTP_PASSWORD": "test-password",
        }), patch.object(server, "send_password_reset_email") as send_email:
            status, response = self.request(
                self.client,
                "/api/password-reset-request",
                "POST",
                {"email": "nao-existe@example.com"},
            )
        self.assertEqual(status, 200)
        self.assertIn("Se houver uma conta", response["message"])
        send_email.assert_not_called()

    def test_password_reset_reports_missing_email_configuration(self):
        self.register(self.client, "Helena", "helena@example.com")
        with patch.dict(os.environ, {}, clear=True):
            status, response = self.request(
                self.client,
                "/api/password-reset-request",
                "POST",
                {"email": "helena@example.com"},
            )
        self.assertEqual(status, 503)
        self.assertIn("não está configurada", response["error"])

    def test_profiles_are_private_and_can_be_updated(self):
        self.register(self.client, "Camila Martins", "camila@example.com")
        status, profile = self.request(self.client, "/api/profile")
        self.assertEqual(status, 200)
        self.assertEqual(profile["business_name"], "Negócio de Camila")
        self.assertEqual(profile["initials"], "CM")
        status, _ = self.request(self.client, "/api/profile", "PUT", {
            "business_name": "Mercadinho da Cami",
            "owner_name": "Camila Martins",
            "role": "Administradora",
            "preferences": {"currency": "BRL"},
        })
        self.assertEqual(status, 200)
        self.assertEqual(self.request(self.client, "/api/session")[1]["user"]["profile"]["business_name"], "Mercadinho da Cami")

        other_client = self.new_client()
        self.register(other_client, "João Silva", "joao@example.com")
        other_profile = self.request(other_client, "/api/profile")[1]
        self.assertEqual(other_profile["business_name"], "Negócio de João")
        self.assertNotEqual(other_profile["business_name"], profile["business_name"])

    def test_losses_update_and_restore_stock_and_create_notifications(self):
        self.register(self.client, "Iara", "iara@example.com")
        _, product = self.request(self.client, "/api/products", "POST", {
            "name": "Bolo",
            "quantity": 5,
            "cost_price": 7,
            "sale_price": 12,
            "min_stock": 3,
        })
        status, loss = self.request(self.client, "/api/losses", "POST", {
            "product_id": product["id"],
            "quantity": 2,
            "amount": 14,
            "reason": "Avaria",
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.request(self.client, "/api/products")[1][0]["quantity"], 3)
        self.assertEqual(self.request(self.client, "/api/notifications")[1]["unread_count"], 3)

        status, _ = self.request(self.client, f"/api/losses/{loss['id']}", "PUT", {
            "product_id": product["id"],
            "quantity": 1,
            "amount": 7,
            "reason": "Vencido",
        })
        self.assertEqual(status, 204)
        self.assertEqual(self.request(self.client, "/api/products")[1][0]["quantity"], 4)
        self.assertEqual(self.request(self.client, f"/api/losses/{loss['id']}", "DELETE")[0], 204)
        self.assertEqual(self.request(self.client, "/api/products")[1][0]["quantity"], 5)
        titles = {item["title"] for item in self.request(self.client, "/api/notifications")[1]["items"]}
        self.assertIn("Perda atualizada", titles)
        self.assertIn("Perda excluída", titles)

    def test_expense_and_manual_sale_crud_update_dashboard_totals(self):
        self.register(self.client, "Joana", "joana@example.com")
        today = server.datetime.now().strftime("%Y-%m-%d")
        status, expense = self.request(self.client, "/api/expenses", "POST", {
            "description": "Conta de luz",
            "category": "Contas",
            "amount": 55.25,
            "expense_date": today,
        })
        self.assertEqual(status, 201)
        status, sale = self.request(self.client, "/api/sales", "POST", {
            "description": "Venda no balcão",
            "amount": 120,
            "sale_date": today,
            "payment_method": "PIX",
        })
        self.assertEqual(status, 201)
        dashboard = self.request(self.client, "/api/dashboard?period=today")[1]
        self.assertEqual(float(dashboard["expenses_this_month"]), 55.25)
        self.assertEqual(float(dashboard["sales_today"]["total"]), 120)
        self.assertGreaterEqual(len(dashboard["sales_chart"]), 1)

        self.assertEqual(self.request(self.client, f"/api/expenses/{expense['id']}", "PUT", {
            "description": "Energia",
            "category": "Contas",
            "amount": 65,
            "expense_date": today,
        })[0], 204)
        self.assertEqual(self.request(self.client, f"/api/sales/{sale['id']}", "PUT", {
            "description": "Venda atualizada",
            "amount": 100,
            "sale_date": today,
            "payment_method": "Dinheiro",
        })[0], 204)
        self.assertEqual(float(self.request(self.client, "/api/dashboard")[1]["expenses_this_month"]), 65)
        titles = {item["title"] for item in self.request(self.client, "/api/notifications")[1]["items"]}
        self.assertIn("Gasto atualizado", titles)
        self.assertIn("Venda atualizada", titles)
        self.assertEqual(self.request(self.client, f"/api/notifications/read-all", "POST", {})[0], 204)
        self.assertEqual(self.request(self.client, "/api/notifications")[1]["unread_count"], 0)
        self.assertEqual(self.request(self.client, f"/api/sales/{sale['id']}", "DELETE")[0], 204)
        self.assertEqual(self.request(self.client, f"/api/expenses/{expense['id']}", "DELETE")[0], 204)
        titles = {item["title"] for item in self.request(self.client, "/api/notifications")[1]["items"]}
        self.assertIn("Venda excluída", titles)
        self.assertIn("Cadastro excluído", titles)


if __name__ == "__main__":
    unittest.main()
