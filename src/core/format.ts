const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export function rupees(n: number): string {
  return inr.format(n);
}

export function shortLabel(s: string, max = 40): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
