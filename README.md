# Iran Payment Gateway Proxy

A reverse proxy server for Iranian payment gateways (Zarinpal, Zibal, Vandar) with host-based redirection support and CORS handling. Built with Node.js, this proxy helps frontend apps securely and seamlessly interact with local gateway APIs, bypassing CORS and enabling zero changes to the gateway URL structure.

---

##  Features

- **Reverse Proxy** for:
  - [Zarinpal](https://zarinpal.com)
  - [Zibal](https://zibal.ir)
  - [Vandar](https://vandar.io)

-  **Host-based Redirection** with 302
- 🔒 CORS Support (Preflight & headers)
- 🧭 Graceful shutdown support
- 🛡 Custom `Referer` & `Host` headers per gateway
- 💬 Structured logging for proxy and redirects

---

## Requirements

- Node.js v18+ or v22+
- Optional: Docker

---

##  Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Port for the server to listen on |

---

##  Usage

### Install

```bash
npm install
