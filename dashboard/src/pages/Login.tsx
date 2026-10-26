import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { useAuth } from "@/lib/auth";

export function LoginPage() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-sidebar p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <span className="text-lg font-semibold">DawaDesk</span>
        </div>
        <div>
          <h2 className="text-3xl font-semibold leading-tight">Your pharmacy's orders, chats and stock in one place.</h2>
          <p className="mt-3 max-w-md text-slate-400">
            Orders from Telegram and WhatsApp, pharmacist questions, delivery agents and stock, updated live.
          </p>
        </div>
        <p className="text-xs text-slate-500">For pharmacy staff only. Customer data is confidential.</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="lg:hidden">
            <img src="/favicon.svg" alt="" className="mb-3 size-10" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
            <p className="mt-1 text-sm text-muted">Use the email and password your admin gave you.</p>
          </div>
          <Field label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
          <Button type="submit" className="w-full" size="lg" loading={busy}>
            Log in
          </Button>
          <p className="text-center text-xs text-muted">Forgot your password? Ask an admin to reset it.</p>
        </form>
      </div>
    </div>
  );
}
