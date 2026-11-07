# MicroGestão

Aplicativo web responsivo e instalável (PWA) para pequenos negócios. Inclui cadastro e login, perfil do negócio, painel, estoque, vendas, fornecedores, categorias, perdas, gastos e notificações.

## Executar no computador

Requer Python 3.10 ou mais recente. O aplicativo não precisa instalar pacotes externos.

No PowerShell:

```powershell
Set-Location "C:\Users\sandr\OneDrive\Documentos\FACULDADE\PRATICA_EXTE\MICROGESTAO\app"
py server.py
```

Abra `http://127.0.0.1:8000` no navegador e crie uma conta. O banco `microgestao.db` é criado automaticamente ao lado de `server.py`, usando o esquema em `..\BANCO SQL`.

Para trocar a porta antes de iniciar:

```powershell
$env:MICROGESTAO_PORT = "8080"
py server.py
```

Os testes automatizados rodam com:

```powershell
py -m unittest discover -s tests -v
```

## Permitir testes na mesma rede Wi-Fi

Conecte o computador e os outros dispositivos à mesma rede Wi-Fi. Na pasta `MICROGESTAO\app`, inicie o servidor assim:

```powershell
$env:MICROGESTAO_HOST = "0.0.0.0"
py server.py
```

No computador, execute `ipconfig` e procure o endereço IPv4 do adaptador Wi-Fi. Em outro dispositivo da mesma rede, abra `http://ENDERECO-IP:8000`, substituindo `ENDERECO-IP` pelo endereço encontrado. Se o Windows perguntar, permita o Python somente em redes privadas.

O servidor precisa permanecer ligado. Esse modo é apenas para testes na rede local: não encaminhe portas do roteador nem exponha o servidor diretamente à internet.

## Instalar no Android

O app pode ser instalado pelo menu do navegador quando publicado em um endereço HTTPS. A instalação PWA não gera um APK nem publica o app na Play Store. O endereço local `127.0.0.1` serve apenas para desenvolvimento no computador; para usar no celular fora da rede local, é necessário hospedar o app com HTTPS.

## Dados e segurança

O banco fica no computador que executa o servidor; não há sincronização entre dispositivos nem hospedagem na nuvem nesta versão. Faça cópias de segurança de `microgestao.db`. Senhas são armazenadas com PBKDF2 e a sessão usa cookie `HttpOnly`. Antes de disponibilizar o app na internet, configure HTTPS, backups e os controles de segurança adequados para produção.

O login por Google está reservado no esquema, mas ainda não foi integrado. O acesso é feito com uma conta criada usando e-mail e senha.

## Recuperação de senha por e-mail

O link “Esqueceu a senha?” envia um link de uso único, válido por 30 minutos. Para habilitar o envio, configure no ambiente do servidor:

- `MICROGESTAO_PUBLIC_URL`: endereço HTTPS do app. HTTP é aceito apenas em `localhost` para desenvolvimento.
- `MICROGESTAO_SMTP_HOST`, `MICROGESTAO_SMTP_PORT`, `MICROGESTAO_SMTP_USER` e `MICROGESTAO_SMTP_PASSWORD`: dados de acesso do servidor de e-mail.
- `MICROGESTAO_SMTP_FROM`: endereço remetente (opcional; usa o usuário SMTP quando omitido).
- `MICROGESTAO_SMTP_SECURITY`: `starttls` (padrão, normalmente porta 587) ou `ssl` (normalmente porta 465).

Sem essas configurações, o app informa que a recuperação por e-mail não está habilitada; não altera a senha nem simula o envio.