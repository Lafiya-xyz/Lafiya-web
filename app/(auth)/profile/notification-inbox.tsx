"use client";

import { useEffect, useMemo, useState } from "react";

import { formatDateTime } from "@/lib/format/datetime";
import {
  INBOX_MESSAGES,
  unreadCount,
  upsertNotification,
  type InboxNotification,
} from "@/lib/notifications/inbox";
import { createClient } from "@/lib/supabase/client";

/**
 * Issue #764: in-app inbox for security and access notifications. Rows are
 * RLS-scoped to the owner; new rows arrive via Supabase Realtime without a
 * page reload.
 */
export function NotificationInbox({
  userId,
  initial,
}: {
  userId: string;
  initial: InboxNotification[];
}) {
  const [items, setItems] = useState<InboxNotification[]>(initial);
  const supabase = useMemo(() => createClient(), []);
  const unread = unreadCount(items);

  useEffect(() => {
    const channel = supabase
      .channel(`user_notifications:${userId}`)
      .on(
        "postgres_changes" as never,
        {
          event: "*",
          schema: "public",
          table: "user_notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: InboxNotification }) => {
          if (payload.new?.id) {
            setItems((current) => upsertNotification(current, payload.new));
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, userId]);

  async function markRead(id: string) {
    const readAt = new Date().toISOString();
    setItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, read_at: readAt } : item,
      ),
    );
    await (supabase as any)
      .from("user_notifications")
      .update({ read_at: readAt })
      .eq("id", id);
  }

  return (
    <section
      aria-labelledby="notification-inbox-heading"
      data-testid="notification-inbox"
      className="rounded-lg border border-zinc-300 p-5 dark:border-zinc-700"
    >
      <h2 id="notification-inbox-heading" className="font-semibold">
        Notifications{" "}
        <span
          data-testid="notification-unread-count"
          aria-live="polite"
          className="text-sm font-normal text-zinc-600 dark:text-zinc-400"
        >
          ({unread} unread)
        </span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          No notifications yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2" aria-live="polite">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="notification-item"
              className={`flex flex-wrap items-center justify-between gap-2 text-sm ${
                item.read_at
                  ? "text-zinc-600 dark:text-zinc-400"
                  : "font-semibold"
              }`}
            >
              <span>
                {item.read_at ? null : (
                  <span className="sr-only">Unread: </span>
                )}
                {INBOX_MESSAGES[item.type]}{" "}
                <time dateTime={item.created_at} className="font-normal">
                  {formatDateTime(item.created_at)}
                </time>
              </span>
              {item.read_at ? null : (
                <button
                  type="button"
                  onClick={() => void markRead(item.id)}
                  className="rounded-full border border-zinc-950 px-3 py-1 text-xs focus:ring-2 focus:ring-zinc-400 focus:outline-none dark:border-zinc-50"
                >
                  Mark as read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
