import { z } from "zod";

export type ZodErrorSummary = {
  error: string;
  errors?: Record<string, string>;
};

export function formatZodError(error: z.ZodError): ZodErrorSummary {
  const fieldErrors: Record<string, string> = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return {
    error: error.issues[0]?.message ?? "Invalid input",
    ...(Object.keys(fieldErrors).length > 0 ? { errors: fieldErrors } : {}),
  };
}
