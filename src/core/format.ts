const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export function rupees(n: number): string {
  return inr.format(n);
}

export function money(paise: number): string {
  return inr.format(paise / 100);
}

export function shortLabel(s: string, max = 40): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function formatPhone(phone: string): string {
  const d = phone.replace(/^\+91/, "");
  return /^\d{10}$/.test(d) ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : phone;
}

export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}
