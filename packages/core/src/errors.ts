export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "forbidden"
      | "conflict"
      | "invalid_transition"
      | "validation"
      | "expired",
    public readonly status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export const notFound = (what: string) => new DomainError(`${what} not found`, "not_found", 404);
export const forbidden = (why: string) => new DomainError(why, "forbidden", 403);
export const conflict = (why: string) => new DomainError(why, "conflict", 409);
