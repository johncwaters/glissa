export function webSocketProtocolFor(pageProtocol) {
  if (pageProtocol === 'https:') return 'wss:';
  return 'ws:';
}

export function buildWebSocketUrl(locationLike, pathnameAndSearch) {
  const protocol = webSocketProtocolFor(locationLike?.protocol);
  return `${protocol}//${locationLike.host}${pathnameAndSearch}`;
}
