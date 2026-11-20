import type { LucideIcon } from "lucide-react";
import { Bell, Download, HardDrive, History, LayoutDashboard, ScrollText, Server } from "lucide-react";
import { defineMessages } from "@/i18n";

export const navMessages = defineMessages({
  en: {
    backups: "Backups",
    dashboard: "Dashboard",
    sources: "Sources",
    runs: "Runs",
    settings: "Settings",
    target: "Target",
    notifications: "Notifications",
    audit: "Audit log",
    updates: "Updates",
  },
});

export type NavKey = keyof typeof navMessages.en;
export type NavItem = { key: NavKey; to: string; icon: LucideIcon };
export type NavGroup = { key: NavKey; items: NavItem[] };

/** The sidebar's groups. Only admins sign in, so everyone sees all of them. */
export const NAVIGATION: NavGroup[] = [
  {
    key: "backups",
    items: [
      { key: "dashboard", to: "/", icon: LayoutDashboard },
      { key: "sources", to: "/sources", icon: HardDrive },
      { key: "runs", to: "/runs", icon: History },
    ],
  },
  {
    key: "settings",
    items: [
      { key: "target", to: "/settings/target", icon: Server },
      { key: "notifications", to: "/settings/notifications", icon: Bell },
      { key: "audit", to: "/admin/audit", icon: ScrollText },
      { key: "updates", to: "/admin/updates", icon: Download },
    ],
  },
];
