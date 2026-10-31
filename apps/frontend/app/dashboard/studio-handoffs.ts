type Handoff = { id?: string; agent: string };

export function selectHandoffs<T extends Handoff>(handoffs: T[], reviewedIds: string[] = []) {
  const newest = [...handoffs].reverse();
  const reviewed = new Set(reviewedIds);
  const current = newest.filter((handoff, index) =>
    Boolean(handoff.id && reviewed.has(handoff.id)) ||
    !newest.slice(0, index).some(previous => previous.agent === handoff.agent))
    .sort((a, b) => Number(Boolean(b.id && reviewed.has(b.id))) - Number(Boolean(a.id && reviewed.has(a.id))));
  return { current, historical: newest.filter(handoff => !current.includes(handoff)) };
}
