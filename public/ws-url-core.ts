export function webSocketProtocolFor(pageProtocol: string | undefined) {
  if (pageProtocol === 'https:') return 'wss:';
  return 'ws:';
}

export function buildWebSocketUrl(locationLike: { protocol?: string; host: string }, pathnameAndSearch: string) {
  const protocol = webSocketProtocolFor(locationLike?.protocol);
  return `${protocol}//${locationLike.host}${pathnameAndSearch}`;
}
