import { z } from 'zod';
export declare const BrowserConfig: z.ZodObject<{
    port: z.ZodOptional<z.ZodNumber>;
    autoRecoverSeconds: z.ZodOptional<z.ZodNumber>;
    inputGraceSeconds: z.ZodOptional<z.ZodNumber>;
    promptDetectionMs: z.ZodOptional<z.ZodNumber>;
    notifyDebounceMs: z.ZodOptional<z.ZodNumber>;
    phoneEscalationMs: z.ZodOptional<z.ZodNumber>;
    replayBufferKB: z.ZodOptional<z.ZodNumber>;
    cursorBlink: z.ZodOptional<z.ZodBoolean>;
    debugMode: z.ZodOptional<z.ZodBoolean>;
    detectBackgroundAgents: z.ZodOptional<z.ZodBoolean>;
    recordSignals: z.ZodOptional<z.ZodBoolean>;
    antiSlopPrompt: z.ZodOptional<z.ZodBoolean>;
    rtk: z.ZodOptional<z.ZodBoolean>;
    checkForUpdates: z.ZodOptional<z.ZodBoolean>;
    autoResume: z.ZodOptional<z.ZodBoolean>;
    telegramNotifications: z.ZodOptional<z.ZodBoolean>;
    packsAutoRebuild: z.ZodOptional<z.ZodBoolean>;
    integrationBranch: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>> | z.ZodOptional<z.ZodString>;
    worktreeRoot: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>> | z.ZodOptional<z.ZodString>;
    worktreeShare: z.ZodOptional<z.ZodArray<z.ZodString>>;
    repoRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    prReview: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    branchGc: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    visions: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    posthog: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    usage: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    telegram: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    packDistiller: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    memory: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    ingest: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
}, z.core.$strip>;
export declare const ConfigUpdate: z.ZodObject<{
    cursorBlink: z.ZodOptional<z.ZodBoolean>;
    debugMode: z.ZodOptional<z.ZodBoolean>;
    detectBackgroundAgents: z.ZodOptional<z.ZodBoolean>;
    recordSignals: z.ZodOptional<z.ZodBoolean>;
    antiSlopPrompt: z.ZodOptional<z.ZodBoolean>;
    rtk: z.ZodOptional<z.ZodBoolean>;
    checkForUpdates: z.ZodOptional<z.ZodBoolean>;
    autoResume: z.ZodOptional<z.ZodBoolean>;
    telegramNotifications: z.ZodOptional<z.ZodBoolean>;
    packsAutoRebuild: z.ZodOptional<z.ZodBoolean>;
    integrationBranch: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>> | z.ZodOptional<z.ZodString>;
    worktreeRoot: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>> | z.ZodOptional<z.ZodString>;
    repoRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    prReview: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    branchGc: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    visions: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    posthog: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    usage: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    telegram: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        [x: string]: z.core.$ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
    }, z.core.$strip>>>;
    packDistiller: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    memory: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    ingest: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    autoRecoverSeconds: z.ZodOptional<z.ZodNumber>;
    inputGraceSeconds: z.ZodOptional<z.ZodNumber>;
    promptDetectionMs: z.ZodOptional<z.ZodNumber>;
    notifyDebounceMs: z.ZodOptional<z.ZodNumber>;
    phoneEscalationMs: z.ZodOptional<z.ZodNumber>;
    replayBufferKB: z.ZodOptional<z.ZodNumber>;
    worktreeAutoRebase: z.ZodOptional<z.ZodBoolean>;
    worktreeSyncOnStart: z.ZodOptional<z.ZodBoolean>;
    worktreeRerere: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const ProjectConfig: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    path: z.ZodString;
    agent: z.ZodOptional<z.ZodEnum<{
        "claude-code": "claude-code";
        codex: "codex";
        grok: "grok";
    }>>;
    codexBypassHookTrust: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
export declare const Config: z.ZodObject<{
    port: z.ZodOptional<z.ZodNumber>;
    autoRecoverSeconds: z.ZodOptional<z.ZodNumber>;
    inputGraceSeconds: z.ZodOptional<z.ZodNumber>;
    promptDetectionMs: z.ZodOptional<z.ZodNumber>;
    notifyDebounceMs: z.ZodOptional<z.ZodNumber>;
    phoneEscalationMs: z.ZodOptional<z.ZodNumber>;
    replayBufferKB: z.ZodOptional<z.ZodNumber>;
    cursorBlink: z.ZodOptional<z.ZodBoolean>;
    debugMode: z.ZodOptional<z.ZodBoolean>;
    detectBackgroundAgents: z.ZodOptional<z.ZodBoolean>;
    recordSignals: z.ZodOptional<z.ZodBoolean>;
    antiSlopPrompt: z.ZodOptional<z.ZodBoolean>;
    rtk: z.ZodOptional<z.ZodBoolean>;
    checkForUpdates: z.ZodOptional<z.ZodBoolean>;
    autoResume: z.ZodOptional<z.ZodBoolean>;
    telegramNotifications: z.ZodOptional<z.ZodBoolean>;
    packsAutoRebuild: z.ZodOptional<z.ZodBoolean>;
    integrationBranch: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>> | z.ZodOptional<z.ZodString>;
    worktreeRoot: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>> | z.ZodOptional<z.ZodString>;
    worktreeShare: z.ZodOptional<z.ZodArray<z.ZodString>>;
    repoRoots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    prReview: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    branchGc: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    visions: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    posthog: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    usage: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    telegram: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    packDistiller: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    memory: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    ingest: z.ZodOptional<z.ZodNullable<z.ZodObject<{}, z.core.$loose>>>;
    detectScheduledWakeups: z.ZodOptional<z.ZodBoolean>;
    worktreeAutoRebase: z.ZodOptional<z.ZodBoolean>;
    worktreeSyncOnStart: z.ZodOptional<z.ZodBoolean>;
    worktreeRerere: z.ZodOptional<z.ZodBoolean>;
    postTurnChecks: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    hooks: z.ZodOptional<z.ZodUnknown>;
    remote: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        port: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        publicHost: z.ZodOptional<z.ZodString>;
        allowedOrigins: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$loose>>;
    projects: z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        path: z.ZodString;
        agent: z.ZodOptional<z.ZodEnum<{
            "claude-code": "claude-code";
            codex: "codex";
            grok: "grok";
        }>>;
        codexBypassHookTrust: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export declare const BROWSER_CONFIG_KEYS: readonly string[];
export declare const CONFIG_BLOCK_KEYS: readonly string[];
export declare const CONFIG_SCALAR_KEYS: readonly string[];
export declare const RUNTIME_CONFIG_SCALAR_KEYS: readonly string[];
export declare const HIDDEN_CONFIG_KEYS: readonly string[];
export declare function configIssueMessage(error: z.ZodError): string;
export type Config = z.infer<typeof Config>;
export type BrowserConfig = z.infer<typeof BrowserConfig>;
export type ConfigUpdate = z.infer<typeof ConfigUpdate>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
