/** `jailbreak` namespace dictionaries (the composer jailbreak chip's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.on.aria': '破甲模式已开启，按下关闭',
  'chip.on.title': '破甲模式已开启 — 点击关闭（/jailbreak off）',
  'chip.off.aria': '破甲模式已关闭，按下开启',
  'chip.off.title': '破甲模式已关闭 — 点击开启（/jailbreak）',
} satisfies Record<string, string>

/** The jailbreak namespace key union. */
export type JailbreakKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'chip.on.aria': 'Jailbreak mode on, press to turn off',
  'chip.on.title': 'Jailbreak mode on — click to turn off (/jailbreak off)',
  'chip.off.aria': 'Jailbreak mode off, press to turn on',
  'chip.off.title': 'Jailbreak mode off — click to turn on (/jailbreak)',
} satisfies Record<JailbreakKey, string>
