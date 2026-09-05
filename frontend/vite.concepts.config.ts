import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins:[react(),{name:"concept-index",enforce:"post",generateBundle:{order:"post",handler(_options,bundle){const html=bundle["concepts.html"];if(html){html.fileName="index.html";bundle["index.html"]=html;delete bundle["concepts.html"];}}}}],
  build:{outDir:"../output/playwright/ui-concepts/dist",emptyOutDir:true,rollupOptions:{input:"concepts.html"}},
});
