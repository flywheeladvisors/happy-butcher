// Which section of the meat case a cut belongs to. Shared by the sidebar and the Wednesday email,
// which both group cuts as Beef, then Chicken, then Pork.

export const CUT_GROUPS = ["Beef", "Chicken", "Pork", "Other"] as const;
export type CutGroup = (typeof CUT_GROUPS)[number];

export function cutGroup(name: string): CutGroup {
  const n = name.toLowerCase();
  if (/chicken|thigh|breast|wing|drumstick/.test(n)) return "Chicken";
  if (/pork|picnic|ham\b|bacon|chop/.test(n)) return "Pork";
  if (/beef|steak|ribeye|strip|broil|filet|sirloin|brisket|chuck|ground|roast/.test(n)) return "Beef";
  return "Other";
}

/** Groups items by section, keeping Beef, Chicken, Pork order and dropping empty sections. */
export function groupCuts<T>(items: T[], nameOf: (item: T) => string): { group: CutGroup; items: T[] }[] {
  return CUT_GROUPS.map((group) => ({ group, items: items.filter((i) => cutGroup(nameOf(i)) === group) })).filter((g) => g.items.length > 0);
}
