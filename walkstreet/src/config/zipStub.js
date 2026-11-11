// @zip.js/zip.js 2.24 移除了 lib/zip-no-worker.js，而 Cesium 的 KML 模块
// （KmlDataSource.js / exportKml.js）仍引用该旧路径，导致 Vite 解析 500。
// 本项目不加载 KMZ/KML 数据，这里提供空实现仅为让模块解析通过。
export const ZipReader = class {};
export const ZipWriter = class {};
export const TextReader = class {};
export const TextWriter = class {};
export const BlobReader = class {};
export const BlobWriter = class {};
export const Data64URIReader = class {};
export const Data64URIWriter = class {};
export const HttpReader = class {};
export const HttpRangeReader = class {};
export const Uint8ArrayReader = class {};
export const Uint8ArrayWriter = class {};
export const ERR_INVALID_PASSWORD = 0;
export const ERR_INVALID_SIGNATURE = 1;
export const ERR_INVALID_FORMAT = 2;
export const ERR_CENTRAL_DIRECTORY_NOT_FOUND = 3;
export const ERR_LOCAL_FILE_HEADER_NOT_FOUND = 4;
export const ERR_EXTRAFIELD_ZIP64_NOT_FOUND = 5;
export const ERR_ENCRYPTED = 6;
export const ERR_UNSUPPORTED_COMPRESSION = 7;
export const ERR_UNSUPPORTED_ENCRYPTION = 8;
export const ERR_INVALID_UNENCRYPTED_SIZE = 9;
export const configure = () => {};
export const getConfiguration = () => ({});
