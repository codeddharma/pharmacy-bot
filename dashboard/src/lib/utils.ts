import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export const money = (paise: number) => inr.format(paise / 100);
export const moneyShort = (paise: number) => inr0.format(paise / 100);
export const rupees = (r: number) => inr.format(r);

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "–";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(v));
}

export function timeAgo(v: string | Date | null | undefined): string {
  if (!v) return "–";
  const mins = Math.round((Date.now() - new Date(v).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return dateTime(v);
}

export function minutesSince(v: string | Date): number {
  return Math.round((Date.now() - new Date(v).getTime()) / 60_000);
}

export function phone(p: string | null | undefined): string {
  if (!p) return "–";
  const d = p.replace(/^\+91/, "");
  return /^\d{10}$/.test(d) ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : p;
}

export function mapsLink(lat: number | null | undefined, lng: number | null | undefined, address?: string | null): string {
  if (lat != null && lng != null) return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address ?? "")}`;
}

/** A customer's name, else their phone, else "Customer #12". */
export function customerLabel(name: string | null | undefined, phoneNumber: string | null | undefined, id: number): string {
  return name || (phoneNumber ? phone(phoneNumber) : `Customer #${id}`);
}
