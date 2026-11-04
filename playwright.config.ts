import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'dotnet run --project ../lillehammer-hackaton/BussForTog.API/BussForTog.API.csproj --launch-profile http',
      url: 'http://localhost:5087/api/stasjoner',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ASPNETCORE_ENVIRONMENT: 'Development',
        JourneyApi__Provider: 'Mock',
        Mock__Scenario: 'Normal',
      },
    },
    {
      command: 'npm run dev -- --host localhost --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})