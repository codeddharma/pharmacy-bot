/**
 * Phrases that suggest an emergency. When one appears the bot stops ordering and points
 * the customer to emergency help. Kept deliberately broad: a false alarm costs one message.
 */
const RED_FLAGS = [
  /\boverdose\b/i,
  /\bsuicid/i,
  /\bkill (my ?self|me)\b/i,
  /\bend (my|this) life\b/i,
  /\bwant to die\b/i,
  /\bself[- ]?harm\b/i,
  /\bchest pain\b/i,
  /\b(can'?t|cannot|not able to) breathe\b/i,
  /\bunconscious\b/i,
  /\bseizure\b/i,
  /\bfits?\b.*\b(child|baby|bachcha)\b/i,
  /\bpoison/i,
  /\bswallowed\b.*\b(tablets|pills|whole strip|bottle)\b/i,
  /\b(khudkushi|aatmahatya|atmahatya)\b/i,
  /\bmarna chahta\b|\bmarna chahti\b/i,
  /\bsaans nahi\b/i,
  /\bbehosh\b/i,
  /\bzeher\b/i,
];

export function isRedFlag(text: string): boolean {
  return RED_FLAGS.some((r) => r.test(text));
}

export const EMERGENCY_MESSAGE =
  "This sounds like it could be an emergency. Please get help now:\n" +
  "• Call 112 (emergency) or 108 (ambulance)\n" +
  "• Tele-MANAS mental health helpline: 14416 (free, 24x7)\n\n" +
  "I can't help with this here. Please don't wait.";
