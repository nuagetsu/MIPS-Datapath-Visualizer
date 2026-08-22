import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev
export default defineConfig({
  plugins: [react()],
  server: {
    watch: {
      usePolling: true,
    },
    host: true, // Needed for the Docker Express server port mapping
    strictPort: true,
    port: 5173, 
  },
  base: '/MIPS-Datapath-Visualizer/'
})