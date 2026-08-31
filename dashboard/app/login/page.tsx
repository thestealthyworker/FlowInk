import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next && params.next.startsWith("/") && !params.next.startsWith("//")
    ? params.next
    : "/";

  return (
    <main>
      <h1>FlowInk — sign in</h1>
      <p>
        Single-operator system. Access beyond this page is governed by
        Postgres RLS, not by this page.
      </p>
      <LoginForm next={next} />
    </main>
  );
}
