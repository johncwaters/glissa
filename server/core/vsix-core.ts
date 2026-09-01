const CRC_TABLE = buildCrcTable();
const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;
const STORED = 0;
const ZIP_VERSION = 20;
const UTF8_FLAG = 0x0800;

const DOS_TIME = 0;
const DOS_DATE = 0x21;

interface ZipEntry {
  crc: number;
  size: number;
  offset: number;
}

export interface ZipFile {
  path: string;
  data: Buffer | string;
}

export interface VsixManifest {
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  description?: string;
  engines?: { vscode?: string };
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(entry: ZipEntry, nameBytes: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(STORED, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.size, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry: ZipEntry, nameBytes: Buffer): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(STORED, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function buildZip(files: ZipFile[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Array<{ entry: ZipEntry; nameBytes: Buffer }> = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.path, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const entry = { crc: crc32(data), size: data.length, offset };
    const header = localHeader(entry, nameBytes);
    chunks.push(header, nameBytes, data);
    offset += header.length + nameBytes.length + data.length;
    central.push({ entry, nameBytes });
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const { entry, nameBytes } of central) {
    const header = centralHeader(entry, nameBytes);
    chunks.push(header, nameBytes);
    centralSize += header.length + nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  return Buffer.concat(chunks);
}

function escapeXml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function contentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="json" ContentType="application/json"/>',
    '<Default Extension="js" ContentType="application/javascript"/>',
    '<Default Extension="md" ContentType="text/markdown"/>',
    '<Default Extension="vsixmanifest" ContentType="text/xml"/>',
    '</Types>',
  ].join('');
}

function vsixManifestXml({ id, publisher, version, displayName, description, engine }: {
  id: string;
  publisher: string;
  version: string;
  displayName: string;
  description: string;
  engine: string;
}): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    '<Metadata>',
    `<Identity Language="en-US" Id="${escapeXml(id)}" Version="${escapeXml(version)}" Publisher="${escapeXml(publisher)}"/>`,
    `<DisplayName>${escapeXml(displayName)}</DisplayName>`,
    `<Description xml:space="preserve">${escapeXml(description)}</Description>`,
    '<Tags></Tags>',
    '<Categories>Other</Categories>',
    '<GalleryFlags>Public</GalleryFlags>',
    '<Properties>',
    `<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(engine)}"/>`,
    '<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>',
    '<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>',
    '<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>',
    '</Properties>',
    '</Metadata>',
    '<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>',
    '<Dependencies/>',
    '<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>',
    '</PackageManifest>',
  ].join('');
}

function buildVsix({ manifest, extensionFiles = [] }: { manifest: VsixManifest; extensionFiles?: ZipFile[] }): Buffer {
  const files: ZipFile[] = [
    { path: 'extension.vsixmanifest', data: vsixManifestXml({
      id: manifest.name,
      publisher: manifest.publisher,
      version: manifest.version,
      displayName: manifest.displayName || manifest.name,
      description: manifest.description || manifest.displayName || manifest.name,
      engine: manifest.engines?.vscode || '*',
    }) },
    { path: '[Content_Types].xml', data: contentTypesXml() },
  ];
  for (const file of extensionFiles) files.push({ path: `extension/${file.path}`, data: file.data });
  return buildZip(files);
}

function extensionIdOf(manifest: VsixManifest): string {
  return `${manifest.publisher}.${manifest.name}`;
}

export { buildVsix, buildZip, contentTypesXml, crc32, extensionIdOf, vsixManifestXml };
