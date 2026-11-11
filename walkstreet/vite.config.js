import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// @zip.js/zip.js 2.24 移除了 lib/zip-no-worker.js，但 Cesium KML 模块仍引用
// 该旧路径；项目不使用 KML，重定向到空实现避免解析失败（dev 500 / 构建报错）。
const zipStub = fileURLToPath(new URL("./src/config/zipStub.js", import.meta.url));

// Cesium 静态资源（Workers/Assets/ThirdParty/Widgets）已复制到 public/cesium，
// 运行时通过 window.CESIUM_BASE_URL 定位；仅在 3D 编辑器打开时动态加载。
export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify("/cesium/"),
  },
  resolve: {
    alias: {
      "@zip.js/zip.js/lib/zip-no-worker.js": zipStub,
    },
  },
  // cesium 预打包：其内部 CJS 依赖（mersenne-twister 等）在 dev 源码直连时
  // interop 失败；@zip.js 旧路径问题由上方 alias 解决，可安全预打包。
  optimizeDeps: {
    include: ["cesium"],
  },
  build: {
    chunkSizeWarningLimit: 4500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/cesium")) return "cesium";
        },
      },
    },
  },
});
