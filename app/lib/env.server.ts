import { z } from "zod";

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined)
  .pipe(z.url().optional());

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_NAME: z.string().trim().min(1).default("社内Webアプリ"),
    APP_ORIGIN: z.url().default("http://localhost:3000"),
    AUTH_MODE: z.enum(["dev", "entra"]).default("dev"),
    SESSION_SECRET: z.string().min(32),
    SESSION_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(86400)
      .default(28800),
    ENTRA_CLIENT_ID: z.string().trim().optional(),
    ENTRA_CLIENT_SECRET: z.string().trim().optional(),
    ENTRA_TENANT_ID: z.string().trim().optional(),
    ENTRA_REDIRECT_URI: optionalUrl,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && value.AUTH_MODE !== "entra") {
      context.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "本番環境では AUTH_MODE=entra が必須です",
      });
    }

    if (value.AUTH_MODE === "entra") {
      for (const key of [
        "ENTRA_CLIENT_ID",
        "ENTRA_CLIENT_SECRET",
        "ENTRA_TENANT_ID",
        "ENTRA_REDIRECT_URI",
      ] as const) {
        if (!value[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} は AUTH_MODE=entra のとき必須です`,
          });
        }
      }
    }
  });

const result = schema.safeParse(process.env);

if (!result.success) {
  const message = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`環境変数が不正です:\n${message}`);
}

export const env = result.data;
