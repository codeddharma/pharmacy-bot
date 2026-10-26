import type { Settings } from "./settings.ts";

/** Straight-line distance in km. Road distance is usually 20–40% more; keep the radius conservative. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Delivery time text for a distance; the widest band when the distance is unknown. */
export function etaBand(distanceKm: number | null, delivery: Settings["delivery"]): string {
  const bands = [...delivery.etaBands].sort((a, b) => a.maxKm - b.maxKm);
  if (distanceKm === null) return bands[bands.length - 1]!.text;
  return (bands.find((b) => distanceKm <= b.maxKm) ?? bands[bands.length - 1]!).text;
}

export function distanceFromPharmacy(s: Settings, lat: number | null, lng: number | null): number | null {
  if (lat === null || lng === null || s.pharmacy.lat === null || s.pharmacy.lng === null) return null;
  return Math.round(haversineKm({ lat: s.pharmacy.lat, lng: s.pharmacy.lng }, { lat, lng }) * 10) / 10;
}
