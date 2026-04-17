import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")

  return {
    plugins: [react()],
    define: {
      __GOOGLE_MAPS_API_KEY__: JSON.stringify(
        env.VITE_GOOGLE_MAPS_API_KEY || "",
      ),
    },
  }
})
