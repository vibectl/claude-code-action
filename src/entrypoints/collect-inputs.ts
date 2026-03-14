import { readFileSync } from "fs";

export function collectActionInputsPresence(): string {
  const inputDefaults: Record<string, string> = {
    trigger_phrase: "@claude",
    assignee_trigger: "",
    label_trigger: "claude",
    base_branch: "",
    branch_prefix: "claude/",
    allowed_bots: "",
    mode: "tag",
    model: "",
    anthropic_model: "",
    fallback_model: "",
    allowed_tools: "",
    disallowed_tools: "",
    custom_instructions: "",
    direct_prompt: "",
    override_prompt: "",
    additional_permissions: "",
    claude_env: "",
    settings: "",
    anthropic_api_key: "",
    claude_code_oauth_token: "",
    github_token: "",
    max_turns: "",
    use_sticky_comment: "false",
    classify_inline_comments: "true",
    use_commit_signing: "false",
    ssh_signing_key: "",
  };

  let allInputsJson = process.env.ALL_INPUTS;
  if (!allInputsJson) {
    // Fallback: read from task config file (non-Actions contexts)
    const configPath = process.env.VIBECTL_TASK_CONFIG;
    if (configPath) {
      try {
        allInputsJson = readFileSync(configPath, "utf-8");
      } catch (err: unknown) {
        // Distinguish expected failures (file not found) from unexpected errors
        // (permissions, disk errors). Expected: ENOENT when config file doesn't
        // exist yet. Unexpected: EACCES, EIO, etc. — log a warning so operators
        // can diagnose without failing the task.
        const isExpected =
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT";
        if (!isExpected) {
          console.warn(
            `[collect-inputs] Unexpected error reading VIBECTL_TASK_CONFIG (${configPath}):`,
            err,
          );
        }
      }
    }
  }
  if (!allInputsJson) {
    console.log("ALL_INPUTS environment variable not found");
    return JSON.stringify({});
  }

  let allInputs: Record<string, string>;
  try {
    allInputs = JSON.parse(allInputsJson);
  } catch (e) {
    console.error("Failed to parse ALL_INPUTS JSON:", e);
    return JSON.stringify({});
  }

  const presentInputs: Record<string, boolean> = {};

  for (const [name, defaultValue] of Object.entries(inputDefaults)) {
    const actualValue = allInputs[name] || "";

    const isSet = actualValue !== defaultValue;
    presentInputs[name] = isSet;
  }

  return JSON.stringify(presentInputs);
}
