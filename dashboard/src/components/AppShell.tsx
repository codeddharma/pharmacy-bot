import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DropdownMenu, Popover } from "radix-ui";
import {
  Bell,
  BellOff,
  Bike,
  BookOpen,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  MessagesSquare,
  Moon,
  Pill,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Truck,
  User,
  Users,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { toast } from "sonner";
import { api, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLive } from "@/lib/live";
import type { Permission, Settings, ShopStatus } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  perms: Permission[];
  badge?: "openQuestions" | "unreadChats" | "unassignedOrders";
}

const NAV: { section?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: "/", label: "Overview", icon: <LayoutDashboard />, perms: ["stats.view"] },
      { to: "/orders", label: "Orders", icon: <ClipboardList />, perms: ["orders.view"], badge: "unassignedOrders" },
      { to: "/deliveries", label: "My deliveries", icon: <Bike />, perms: ["deliveries.own"] },
      { to: "/inbox", label: "Inbox", icon: <MessagesSquare />, perms: ["inbox.view"], badge: "unreadChats" },
      { to: "/questions", label: "Questions", icon: <MessageCircle />, perms: ["consultations.view"], badge: "openQuestions" },
    ],
  },
  {
    section: "Pharmacy",
    items: [
      { to: "/inventory", label: "Inventory", icon: <Pill />, perms: ["inventory.view"] },
      { to: "/interactions", label: "Interaction rules", icon: <BookOpen />, perms: ["inventory.view"] },
      { to: "/customers", label: "Customers", icon: <Users />, perms: ["customers.view"] },
      { to: "/agents", label: "Delivery agents", icon: <Truck />, perms: ["orders.view"] },
    ],
  },
  {
    section: "Admin",
    items: [
      { to: "/staff", label: "Staff & roles", icon: <ShieldCheck />, perms: ["users.manage", "roles.manage"] },
      { to: "/settings", label: "Settings", icon: <SettingsIcon />, perms: ["settings.manage"] },
      { to: "/activity", label: "Activity log", icon: <ScrollText />, perms: ["audit.view"] },
    ],
  },
];

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("dd-theme", next ? "dark" : "light");
    } catch {
      // storage unavailable; theme still switches for this visit
    }
    setDark(next);
  };
  return { dark, toggle };
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  const badges = useQuery({ queryKey: ["badges"], queryFn: () => api<Record<string, number>>("/badges"), refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<{ settings: Settings }>("/settings") });

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <img src="/favicon.svg" alt="" className="size-8" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{settings.data?.settings.pharmacy.name ?? "DawaDesk"}</div>
          <div className="text-[11px] text-slate-400">DawaDesk</div>
        </div>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {NAV.map((group, gi) => {
          // Staff who see every order don't need the agent's "My deliveries" view.
          const items = group.items.filter((i) => can(...i.perms) && !(i.to === "/deliveries" && can("orders.view")));
          if (items.length === 0) return null;
          return (
            <div key={gi}>
              {group.section ? <div className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">{group.section}</div> : null}
              <div className="space-y-0.5">
                {items.map((item) => {
                  const count = item.badge ? badges.data?.[item.badge] ?? 0 : 0;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === "/"}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors [&_svg]:size-4",
                          isActive ? "bg-sidebar-active font-medium text-white" : "hover:bg-white/5 hover:text-white",
                        )
                      }
                    >
                      {item.icon}
                      <span className="flex-1">{item.label}</span>
                      {count > 0 ? <span className="rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold text-white tabular">{count}</span> : null}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function ShopToggle() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["shop-status"], queryFn: () => api<ShopStatus>("/shop-status"), refetchInterval: 60_000 });
  const set = useMutation({
    mutationFn: (override: "auto" | "open" | "closed") => post<ShopStatus>("/shop-status", { override }),
    onSuccess: (data) => {
      qc.setQueryData(["shop-status"], data);
      toast.success(data.open ? "The shop is open for orders" : "The shop is closed; new orders are scheduled for the next opening");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const s = status.data;
  if (!s) return null;

  const pill = (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold",
        s.open ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
      )}
    >
      <span className={cn("size-2 rounded-full", s.open ? "bg-success" : "bg-danger")} />
      {s.open ? "Open" : "Closed"}
      <span className="hidden font-normal sm:inline">
        {s.override !== "auto" ? "· set manually" : s.open ? `· ${s.todayHours}` : s.nextOpenText ? `· opens ${s.nextOpenText}` : ""}
      </span>
    </span>
  );
  if (!can("hours.toggle", "settings.manage")) return pill;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="Change opening status">{pill}</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-64 rounded-xl border border-border bg-surface p-1.5 text-sm shadow-lg">
          {([
            ["auto", "Follow opening hours", `Today: ${s.todayHours}`],
            ["open", "Open now", "Take orders for same-day delivery"],
            ["closed", "Closed now", "Orders are scheduled for the next opening"],
          ] as const).map(([value, label, hint]) => (
            <DropdownMenu.Item
              key={value}
              onSelect={() => set.mutate(value)}
              className={cn("cursor-pointer rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-surface-muted", s.override === value && "bg-primary-soft")}
            >
              <div className="font-medium">{label}</div>
              <div className="text-xs text-muted">{hint}</div>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function NotificationBell() {
  const live = useLive();
  return (
    <Popover.Root onOpenChange={(o) => o && live.markSeen()}>
      <Popover.Trigger asChild>
        <button type="button" className="relative rounded-lg p-2 text-muted hover:bg-surface-muted hover:text-foreground" aria-label="Notifications">
          <Bell className="size-5" />
          {live.unseen > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">{live.unseen}</span>
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-80 rounded-xl border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">Notifications</span>
            <button type="button" onClick={() => live.setSoundOn(!live.soundOn)} className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground">
              {live.soundOn ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
              Sound {live.soundOn ? "on" : "off"}
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {live.notices.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">Nothing new yet. New orders and questions appear here.</p>
            ) : (
              live.notices.map((n) => (
                <Link key={n.id} to={n.href} className="block border-b border-border px-4 py-3 last:border-0 hover:bg-surface-muted">
                  <div className={cn("text-sm font-medium", n.urgent && "text-danger")}>{n.title}</div>
                  {n.body ? <div className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</div> : null}
                  <div className="mt-1 text-[11px] text-muted">{timeAgo(n.at)}</div>
                </Link>
              ))
            )}
          </div>
          {"Notification" in window && Notification.permission === "default" ? (
            <button type="button" onClick={() => void Notification.requestPermission()} className="w-full border-t border-border px-4 py-2.5 text-xs text-primary hover:bg-surface-muted">
              Show alerts even when this tab is in the background
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  if (!user) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-muted">
          <span className="grid size-8 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">
            {user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
          </span>
          <span className="hidden text-left md:block">
            <span className="block text-sm font-medium leading-tight">{user.name}</span>
            <span className="block text-[11px] leading-tight text-muted">{user.roleName}</span>
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-52 rounded-xl border border-border bg-surface p-1.5 text-sm shadow-lg">
          <DropdownMenu.Item asChild className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-surface-muted">
            <Link to="/profile">
              <User className="size-4" /> My account
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={toggle} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-surface-muted">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />} {dark ? "Light mode" : "Dark mode"}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item onSelect={() => void logout()} className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-danger outline-none data-[highlighted]:bg-danger-soft">
            <LogOut className="size-4" /> Log out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const live = useLive();
  const location = useLocation();

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">
        <Sidebar />
      </aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
          <button type="button" onClick={() => setMobileOpen(false)} className="absolute left-64 top-3 ml-2 rounded-lg bg-surface p-2" aria-label="Close menu">
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
          <button type="button" onClick={() => setMobileOpen(true)} className="rounded-lg p-2 hover:bg-surface-muted lg:hidden" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <ShopToggle />
          <div className="flex-1" />
          {!live.connected ? <span className="hidden text-xs text-warning sm:inline">Reconnecting…</span> : null}
          <NotificationBell />
          <UserMenu />
        </header>
        <main key={location.pathname} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl p-4 sm:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
