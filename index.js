const http = require("http");
const https = require("https");
const url = require("url");

const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 30000;
const GRACEFUL_SHUTDOWN_TIMEOUT = 10000;

const REDIRECTION_MAP = {
  "pay.v1-domain.com": "https://api.myapp.com",
  "pay.v2-domain.com": "https://api.myapp.com",
};

const PAYMENT_GATEWAYS = {
  vandar: {
    target: "https://ipg.vandar.io",
    host: "ipg.vandar.io",
  },
  zibal: {
    target: "https://gateway.zibal.ir",
    host: "gateway.zibal.ir",
  },
  zarinpal: {
    target: "https://payment.zarinpal.com",
    host: "payment.zarinpal.com",
  },
};

const HOST_CONFIG = {
  "pay.v1-domain.com": "https://v1-domain.com/",
  "pay.v2-domain.com": "https://v1-domain.com/",
};

const HOP_BY_HOP_HEADERS = [
  "connection",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
];

class ProxyServer {
  constructor() {
    this.server = null;
  }

  // Removes hop-by-hop headers from request/response
  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    HOP_BY_HOP_HEADERS.forEach((header) => delete sanitized[header]);
    return sanitized;
  }

  async handlePaymentGatewayProxy(req, res, gateway, targetPath, referrer) {
    const gatewayConfig = PAYMENT_GATEWAYS[gateway];
    if (!gatewayConfig) {
      this.sendError(res, 400, "Invalid payment gateway");
      return;
    }

    const targetUrl = gatewayConfig.target + targetPath;
    const customHeaders = {
      Host: gatewayConfig.host,
      Referer: referrer,
    };

    console.log(
      `[${new Date().toISOString()}] PROXY: ${req.method} ${
        req.url
      } → ${targetUrl}`
    );

    try {
      await this.proxyRequest(req, res, targetUrl, customHeaders);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Proxy error for ${targetUrl}:`,
        error.message
      );
      this.sendError(res, 500, "Proxy Error");
    }
  }

  handleRedirect(req, res, targetUrl) {
    console.log(
      `[${new Date().toISOString()}] REDIRECT: ${req.method} ${
        req.url
      } → ${targetUrl}`
    );

    res.writeHead(302, {
      Location: targetUrl,
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(`Redirecting to ${targetUrl}`);
  }

  // Handles CORS preflight requests
  handleCorsPreflightRequest(req, res) {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
  }

  sendError(res, statusCode, message) {
    if (res.headersSent || res.destroyed) return;

    res.writeHead(statusCode, { "Content-Type": "text/plain" });
    res.end(message);
  }

  proxyRequest(req, res, targetUrl, customHeaders = {}) {
    return new Promise((resolve, reject) => {
      const targetUrlObj = new URL(targetUrl);
      const isHttps = targetUrlObj.protocol === "https:";
      const httpModule = isHttps ? https : http;

      // Prepare headers
      const proxyHeaders = this.sanitizeHeaders(req.headers);
      Object.assign(proxyHeaders, customHeaders);
      proxyHeaders.connection = "close";

      const options = {
        hostname: targetUrlObj.hostname,
        port: targetUrlObj.port || (isHttps ? 443 : 80),
        path: targetUrlObj.pathname + targetUrlObj.search,
        method: req.method,
        headers: proxyHeaders,
        timeout: REQUEST_TIMEOUT,
      };

      const proxyReq = httpModule.request(options, (proxyRes) => {
        // Prepare response headers
        const responseHeaders = this.sanitizeHeaders(proxyRes.headers);
        responseHeaders["Access-Control-Allow-Origin"] = "*";
        responseHeaders["Access-Control-Allow-Methods"] =
          "GET, POST, PUT, DELETE, OPTIONS";
        responseHeaders["Access-Control-Allow-Headers"] =
          "Content-Type, Authorization";

        res.writeHead(proxyRes.statusCode, responseHeaders);

        // Handle response streaming
        proxyRes.on("data", (chunk) => {
          if (!res.destroyed) {
            res.write(chunk);
          }
        });

        proxyRes.on("end", () => {
          if (!res.destroyed) {
            res.end();
          }
          resolve();
        });

        proxyRes.on("error", (error) => {
          console.error(
            `[${new Date().toISOString()}] Proxy response error:`,
            error.message
          );
          this.sendError(res, 500, "Internal Server Error");
          reject(error);
        });
      });

      // Handle proxy request errors
      proxyReq.on("error", (error) => {
        console.error(
          `[${new Date().toISOString()}] Proxy request error:`,
          error.message
        );
        this.sendError(res, 500, "Internal Server Error");
        reject(error);
      });

      proxyReq.on("timeout", () => {
        console.error(
          `[${new Date().toISOString()}] Proxy request timeout for ${targetUrl}`
        );
        proxyReq.destroy();
        this.sendError(res, 504, "Gateway Timeout");
        reject(new Error("Request timeout"));
      });

      // Handle client disconnection
      req.on("close", () => {
        if (!proxyReq.destroyed) {
          proxyReq.destroy();
        }
      });

      req.on("error", (error) => {
        console.error(
          `[${new Date().toISOString()}] Client request error:`,
          error.message
        );
        if (!proxyReq.destroyed) {
          proxyReq.destroy();
        }
        reject(error);
      });

      // Forward request body
      if (["POST", "PUT", "PATCH"].includes(req.method)) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    });
  }

  async handleRequest(req, res) {
    const requestHost = req.headers.host;
    const originalPath = req.url;
    const parsedUrl = url.parse(originalPath);
    const pathname = parsedUrl.pathname;

    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
      this.handleCorsPreflightRequest(req, res);
      return;
    }

    // Validate host
    if (!requestHost || !HOST_CONFIG[requestHost]) {
      console.warn(
        `[${new Date().toISOString()}] Unrecognized host: ${requestHost}`
      );
      this.sendError(res, 400, "Bad Request: Unrecognized host");
      return;
    }

    const referrer = HOST_CONFIG[requestHost];

    // Check for payment gateway paths (proxy these)
    for (const [gateway, config] of Object.entries(PAYMENT_GATEWAYS)) {
      const pathPrefix = `/${gateway}/`;

      if (pathname.startsWith(pathPrefix)) {
        const targetPath = originalPath.substring(pathPrefix.length - 1);
        const finalPath = targetPath.startsWith("/")
          ? targetPath
          : "/" + targetPath;

        await this.handlePaymentGatewayProxy(
          req,
          res,
          gateway,
          finalPath,
          referrer
        );
        return;
      }
    }

    // Fall back to regular redirect
    const targetBaseUrl = REDIRECTION_MAP[requestHost];
    if (targetBaseUrl) {
      const targetUrl = targetBaseUrl + originalPath;
      this.handleRedirect(req, res, targetUrl);
    } else {
      console.warn(
        `[${new Date().toISOString()}] No redirect target for host: ${requestHost}`
      );
      this.sendError(res, 400, "Bad Request: No redirect target configured");
    }
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error(
          `[${new Date().toISOString()}] Unhandled request error:`,
          error
        );
        this.sendError(res, 500, "Internal Server Error");
      });
    });

    this.server.listen(PORT, () => {
      console.log(`Proxy Server running on port ${PORT}`);
      console.log("\n Configuration:");

      console.log("\n Host Redirects (302):");
      Object.entries(REDIRECTION_MAP).forEach(([host, target]) => {
        console.log(`  • ${host} → ${target}`);
      });

      console.log("\n Payment Gateway Proxies:");
      Object.entries(HOST_CONFIG).forEach(([host, referrer]) => {
        console.log(`  • ${host}:`);
        Object.entries(PAYMENT_GATEWAYS).forEach(([gateway, config]) => {
          console.log(
            `    - /${gateway}/* → ${config.target}/* (Referer: ${referrer})`
          );
        });
      });

      console.log("\n✅ Server ready to handle requests");
    });

    // Setup graceful shutdown
    this.setupGracefulShutdown();
  }

  setupGracefulShutdown() {
    const shutdown = (signal) => {
      console.log(`\n${signal} received. Shutting down gracefully...`);

      const shutdownTimer = setTimeout(() => {
        console.log("❌ Forced shutdown due to timeout");
        process.exit(1);
      }, GRACEFUL_SHUTDOWN_TIMEOUT);

      this.server.close((error) => {
        clearTimeout(shutdownTimer);

        if (error) {
          console.error("❌ Error during server shutdown:", error);
          process.exit(1);
        }

        console.log("✅ Server closed successfully");
        process.exit(0);
      });
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}

const proxyServer = new ProxyServer();
proxyServer.start();
