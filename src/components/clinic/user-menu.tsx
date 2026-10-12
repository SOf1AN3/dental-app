"use client";

import Link from "next/link";
import { startTransition } from "react";
import { User, Settings, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/lib/actions/auth";

interface UserMenuProps {
  name: string;
  email?: string | null;
}

export function UserMenu({ name, email }: UserMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Menu utilisateur"
        className="rounded-full p-2 text-cool-500 hover:bg-cool-100 dark:hover:bg-cool-800 transition-colors"
      >
        <User className="h-5 w-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <p className="text-sm font-medium text-cool-900">{name}</p>
            {email && <p className="text-xs text-cool-500">{email}</p>}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/settings/general" />}>
          <Settings />
          Paramètres
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => startTransition(() => void logout())}
        >
          <LogOut />
          Se déconnecter
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
