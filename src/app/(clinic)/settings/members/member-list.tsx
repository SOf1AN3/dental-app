"use client";

import { removeMember, updateMemberRole } from "@/lib/actions/membership";
import { useRouter } from "next/navigation";

interface Member {
  id: string;
  userId: string;
  role: string;
  createdAt: Date | null;
  name: string | null;
  email: string | null;
}

const roleLabels: Record<string, string> = {
  owner: "Propriétaire",
  dentist: "Dentiste",
  assistant: "Assistant",
  receptionist: "Réceptionniste",
  viewer: "Lecture seule",
};

export function MemberList({ members }: { members: Member[] }) {
  const router = useRouter();

  async function handleRoleChange(membershipId: string, role: string) {
    const result = await updateMemberRole(membershipId, role);
    if (result && "success" in result) router.refresh();
  }

  async function handleRemove(membershipId: string) {
    if (!confirm("Supprimer ce membre de la clinique ?")) return;
    const result = await removeMember(membershipId);
    if (!result || "error" in result) return;
    router.refresh();
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-cool-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-cool-200 bg-cool-50">
            <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Nom</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Email</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Rôle</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-cool-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id} className="border-b border-cool-100 hover:bg-cool-50 transition-colors">
              <td className="px-4 py-3 font-medium text-cool-900">{member.name || "—"}</td>
              <td className="px-4 py-3 text-cool-600">{member.email || "—"}</td>
              <td className="px-4 py-3">
                {member.role === "owner" ? (
                  <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {roleLabels[member.role]}
                  </span>
                ) : (
                  <select
                    defaultValue={member.role}
                    onChange={(e) => handleRoleChange(member.id, e.target.value)}
                    className="rounded-lg border border-input bg-transparent px-2 py-1 text-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 outline-none"
                  >
                    <option value="dentist">Dentiste</option>
                    <option value="assistant">Assistant</option>
                    <option value="receptionist">Réceptionniste</option>
                    <option value="viewer">Lecture seule</option>
                  </select>
                )}
              </td>
              <td className="px-4 py-3">
                {member.role !== "owner" && (
                  <button
                    onClick={() => handleRemove(member.id)}
                    className="text-xs text-red-600 hover:text-red-800 transition-colors dark:text-red-400 dark:hover:text-red-300"
                  >
                    Supprimer
                  </button>
                )}
                {member.role === "owner" && (
                  <span className="text-xs text-cool-400">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
