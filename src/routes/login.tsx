import { createFileRoute, Link } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-6 text-fg">
      <div className="w-full max-w-sm space-y-4 rounded-3xl bg-surface p-6 shadow-ring">
        <div className="space-y-1">
          <p className="font-display text-3xl leading-none">Sable</p>
          <h1 className="text-lg font-medium">Đăng nhập qua Grok OAuth</h1>
          <p className="text-sm text-muted">Dùng tài khoản Google hoặc X qua broker Grok. Không lưu mật khẩu trên máy này.</p>
        </div>
        {authEnabled ? (
          <div className="flex flex-col gap-2">
            {GROK_PROVIDERS.map((p) => (
              <button
                key={p.providerId}
                type="button"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
                className="min-h-11 w-full rounded-xl bg-accent px-4 text-sm font-medium text-ink hover:opacity-95"
              >
                Tiếp tục với {p.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Đăng nhập đang tắt.</p>
        )}
        <Link to="/" className="block text-center text-sm text-muted hover:text-fg">
          Về bàn Sable
        </Link>
      </div>
    </main>
  );
}
