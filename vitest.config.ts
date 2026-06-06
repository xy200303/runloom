import { defineConfig, mergeConfig } from "vitest/config";
import contractConfig from "./vitest.contract.config.js";
import e2eConfig from "./vitest.e2e.config.js";
import integrationConfig from "./vitest.integration.config.js";
import securityConfig from "./vitest.security.config.js";
import unitConfig from "./vitest.unit.config.js";

const suiteConfigs = [unitConfig, integrationConfig, contractConfig, securityConfig, e2eConfig];

export default mergeConfig(
  defineConfig({
    test: {
      name: "all",
      passWithNoTests: true
    }
  }),
  defineConfig({
    test: {
      projects: suiteConfigs
    }
  })
);
