// BS-SQL-001 clean fixture: no sql tagged templates, no raw SQL, no request interpolation.
// Returns static data only — no user input flows anywhere near SQL.

export function getStaticUsers() {
  return [
    { id: 1, name: 'Alice' },
    { id: 2, name: 'Bob' },
  ];
}

export function getStaticItem(id: number) {
  const items: Record<number, string> = { 1: 'Widget', 2: 'Gadget' };
  return items[id] ?? null;
}
