import { z } from "zod";

const optionalNonEmptyString = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_NAME: z.string().trim().min(1).default("社内Webアプリ"),
    APP_ORIGIN: z.url().default("http://localhost:3000"),
    AUTH_MODE: z.enum(["dev", "easyauth"]).default("dev"),
    SESSION_SECRET: z.string().min(32).optional(),
    SESSION_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(86400)
      .default(28800),
    ENTRA_TENANT_ID: optionalNonEmptyString,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && value.AUTH_MODE !== "easyauth") {
      context.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "本番環境では AUTH_MODE=easyauth が必須です",
      });
    }

    if (value.AUTH_MODE === "easyauth" && !value.ENTRA_TENANT_ID) {
      context.addIssue({
        code: "custom",
        path: ["ENTRA_TENANT_ID"],
        message: "ENTRA_TENANT_ID は AUTH_MODE=easyauth のとき必須です",
      });
    }

    if (value.AUTH_MODE === "dev" && !value.SESSION_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_SECRET"],
        message: "SESSION_SECRET は AUTH_MODE=dev のとき必須です",
      });
    }
  });

export function parseEnvironment(input: NodeJS.ProcessEnv) {
  const result = schema.safeParse(input);

  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`環境変数が不正です:\n${message}`);
  }

  return result.data;
}

export const env = parseEnvironment(process.env);
