import Link from "next/link";
import { getMeOrNull, getUsersOrNull } from "@/lib/api";
import { CreateUserForm } from "@/components/CreateUserForm";
import { CreateInviteButton } from "@/components/CreateInviteButton";

// Deliberately not linked from the global Header/nav - this is a
// direct-URL admin tool, not a page every visitor needs to know about.
export default async function AdminUsersPage() {
  const me = await getMeOrNull();

  if (!me || !me.is_admin) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center text-zinc-400">
        Not authorized.
      </div>
    );
  }

  const users = (await getUsersOrNull()) ?? [];

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Accounts</h1>
        <Link href="/admin/pipeline" className="text-sm text-zinc-400 hover:text-white">
          Pipeline →
        </Link>
      </div>

      <ul className="mb-10 divide-y divide-white/10 rounded-lg border border-white/10">
        {users.map((u) => (
          <li key={u.id} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="text-zinc-200">{u.username}</span>
            {u.is_admin && (
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-zinc-400">
                admin
              </span>
            )}
          </li>
        ))}
      </ul>

      <CreateInviteButton />
      <CreateUserForm />
    </div>
  );
}
