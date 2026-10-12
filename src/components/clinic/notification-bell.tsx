"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, CreditCard, Info, Megaphone, Wrench } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { useRouter } from "next/navigation";
import { getNotifications, markNotificationsRead } from "@/lib/actions/notifications";

type NotificationItem = {
  id: string;
  category: "broadcast" | "maintenance" | "subscription_reminder" | "system";
  title: string;
  message: string;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
};

const categoryIcons = {
  broadcast: Megaphone,
  maintenance: Wrench,
  subscription_reminder: CreditCard,
  system: Info,
} as const;

const categoryTints = {
  broadcast: "bg-cerulean/10 text-cerulean",
  maintenance: "bg-amber/10 text-amber-fg",
  subscription_reminder: "bg-mint/10 text-mint",
  system: "bg-cool-100 text-cool-600",
} as const;

export function NotificationBell({ clinicId }: { clinicId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getNotifications(clinicId).then((data) => {
      if (cancelled) return;
      setUnreadCount(data.unreadCount);
      setItems(data.items);
    });
    return () => {
      cancelled = true;
    };
  }, [clinicId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unreadCount > 0) {
      markNotificationsRead(clinicId);
      setUnreadCount(0);
      setItems((prev) => prev.map((item) => (item.readAt ? item : { ...item, readAt: new Date() })));
    }
  };

  const handleItemClick = (item: NotificationItem) => {
    if (item.link) {
      router.push(item.link);
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={handleToggle}
        aria-label="Notifications"
        className="relative rounded-full p-2 text-cool-500 hover:bg-cool-100 dark:hover:bg-cool-800"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
            {unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-cool-200 bg-white dark:bg-cool-100 shadow-lg">
          <div className="border-b border-cool-100 px-4 py-3 font-medium text-cool-900">Notifications</div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center text-cool-400">Aucune notification</div>
            ) : (
              items.map((item) => {
                const Icon = categoryIcons[item.category] ?? Info;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleItemClick(item)}
                    className={[
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-cool-50",
                      item.readAt ? "" : "bg-cerulean/5",
                    ].join(" ")}
                  >
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                        categoryTints[item.category] ?? "bg-cool-100 text-cool-600"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium text-cool-900">{item.title}</span>
                      <span className="line-clamp-2 text-xs text-cool-500">{item.message}</span>
                      <span className="mt-0.5 text-[11px] text-cool-400">
                        {formatDistanceToNow(new Date(item.createdAt), { locale: fr, addSuffix: true })}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
