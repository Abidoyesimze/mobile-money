import { Router, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { generateOpenAPIDocument } from "../openapi/generator";

export const docsRouter = Router();

const isDev = process.env.NODE_ENV === "development";

function devOnly(_req: Request, res: Response, next: () => void): void {
  if (!isDev) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

docsRouter.get("/openapi.json", devOnly, (_req: Request, res: Response) => {
  const spec = generateOpenAPIDocument();
  res.setHeader("Content-Type", "application/json");
  res.json(spec);
});

docsRouter.get("/swagger.json", devOnly, (_req: Request, res: Response) => {
  const path = require("path");
  const fs = require("fs");
  const swaggerPath = path.resolve(__dirname, "../docs/swagger.json");
  if (fs.existsSync(swaggerPath)) {
    res.sendFile(swaggerPath);
  } else {
    res.status(404).json({ error: "swagger.json not found" });
  }
});

if (isDev) {
  const localSpec = generateOpenAPIDocument();
  const useCdn = process.env.SWAGGER_CDN !== "false";

  const swaggerOptions = {
    customSiteTitle: "Mobile Money Bridge — API Docs",
    ...(useCdn && {
      customCssUrl:
        "https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui.css",
      customJs:
        "https://cdn.jsdelivr.net/npm/swagger-ui-dist/swagger-ui-bundle.js",
    }),
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true,
    },
  };

  docsRouter.use(
    "/",
    devOnly,
    swaggerUi.serve,
    swaggerUi.setup(
      process.env.SWAGGER_SPEC_URL
        ? { url: process.env.SWAGGER_SPEC_URL }
        : localSpec,
      swaggerOptions,
    ),
  );
} else {
  docsRouter.use("/", devOnly, (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });
}
