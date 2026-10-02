import { useState, type FormEvent } from "react";

type Fields = { name: string; email: string; password: string };
type Errors = Partial<Record<keyof Fields, string>>;

const EMPTY: Fields = { name: "", email: "", password: "" };

function validate(f: Fields): Errors {
  const errors: Errors = {};
  if (!f.name.trim()) errors.name = "Name is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) errors.email = "Enter a valid email address.";
  if (f.password.length < 8) errors.password = "Password must be at least 8 characters.";
  return errors;
}

export function SignupForm() {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [submittedName, setSubmittedName] = useState<string | null>(null);

  function update(key: keyof Fields, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const found = validate(fields);
    setErrors(found);
    if (Object.keys(found).length === 0) {
      setSubmittedName(fields.name.trim());
      setFields(EMPTY);
    }
  }

  return (
    <section id="signup" className="card">
      <h2>Sign up</h2>
      {submittedName && (
        <p className="success" data-testid="signup-success">
          Welcome, {submittedName}! Your account is ready.
        </p>
      )}
      <form onSubmit={onSubmit} noValidate data-testid="signup-form">
        {(["name", "email", "password"] as const).map((key) => (
          <label key={key} className="field">
            <span>{key[0].toUpperCase() + key.slice(1)}</span>
            <input
              type={key === "password" ? "password" : key === "email" ? "email" : "text"}
              value={fields[key]}
              onChange={(e) => update(key, e.target.value)}
              aria-invalid={Boolean(errors[key])}
              data-testid={`signup-${key}`}
            />
            {errors[key] && (
              <small className="error" data-testid={`signup-${key}-error`}>
                {errors[key]}
              </small>
            )}
          </label>
        ))}
        <button type="submit" data-testid="signup-submit">
          Create account
        </button>
      </form>
    </section>
  );
}
