export * from './types.js';
export {
  MemoryStore, StoreLockedError, WriteSeqError, UnreplayableWalError, unreplayableWalCopies,
} from './store/store.js';
export { SCHEMA_VERSION, DEFAULT_DIMENSIONS, parseDimensions, ddl } from './store/schema.js';
export { readMeta, writeMeta, updateMeta, bumpWriteSeq, type StoreMeta } from './store/meta.js';
export { awaitHandleRelease, HandleStillLockedError, DEFAULT_RELEASE_BUDGET_MS } from './store/reopen.js';
export { probeCapabilities, summarizeCapability, EXACT_SCAN_LIMIT } from './store/capabilities.js';
export * from './store/registry.js';
export * as journal from './store/journal.js';

export {
  chunk, characterChunk, declarations, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP, CHUNKER_VERSION,
  type Chunk, type Declaration,
} from './ingest/chunker.js';
export { redact, looksRedacted } from './ingest/redact.js';
export {
  relationsIn, type FileRelations, type CallSite, type ImportSite, type Heritage,
} from './ingest/relations.js';
export { type RelationReport, type Confidence } from './ingest/resolve.js';
export {
  ingest,
  type IngestOptions,
  type IngestReport,
  type IgnoredFile,
  type IgnoreReason,
  DEFAULT_MAX_FILE_BYTES,
} from './ingest/ingest.js';
export {
  ruleForFile, KNOWN_LANGUAGES, probeAstChunking, isLanguageAvailable, relationLanguages,
  type AstCapability,
} from './ingest/languages.js';

export * from './embed/index.js';

export { Bm25Index, K1, B, type Bm25Hit } from './search/bm25.js';
export { persistedBm25Search } from './search/persisted-bm25.js';
export { encodePostings, decodePostings, type Postings } from './search/postings.js';
export { semanticSearch, cosineSimilarity } from './search/semantic.js';
export { recencySearch, decayFactor, HALF_LIFE_DAYS, DAY_MS } from './search/recency.js';
export { fuse, RRF_K, type Branch, type FusionOutcome } from './search/rrf.js';
export { search, clearSearchCache, DEFAULT_STALE_AFTER_DAYS, type SearchOptions } from './search/search.js';

export { neighbors, DEFAULT_DEPTH, MAX_DEPTH, type Subgraph, type TraverseOptions } from './graph/traverse.js';
export { clusters, type Cluster } from './graph/cluster.js';
export { conflicts, type Conflict } from './graph/conflicts.js';
export {
  loadCodeIndex, resolveTarget, impact, context as symbolContext, trace, isTestPath,
  confidenceScore, CONFIDENCE_SCORE, DEPTH_LABELS, MAX_IMPACT_DEPTH, MAX_TRACE_DEPTH,
  type CodeIndex, type TargetQuery, type Resolution, type ImpactResult, type ImpactHit,
  type ImpactOptions, type ContextResult, type TraceResult, type TraceOptions, type SymbolRef,
  type Direction, type RiskLevel, type ProcessReport,
} from './graph/code.js';
export {
  buildProcesses, entryPoints, resolveProcess, processesFor,
  MAX_PROCESS_DEPTH, MAX_PROCESS_STEPS, MAX_PROCESSES,
  type Process, type ProcessStep, type ProcessIndex, type ProcessOptions, type ProcessResolution,
} from './graph/process.js';
export {
  query, type QueryResult, type QueryGroup, type QueryHit, type QueryOptions,
} from './graph/query.js';
export {
  check, importCycles, codeClusters, readOnlyCypher,
  type CheckResult, type CheckOptions, type Finding, type Severity, type CodeCluster, type CypherCheck,
} from './graph/inspect.js';
export {
  planRename, applyRename,
  type RenamePlan, type RenameRefusal, type RenameEdit, type TextMatch, type RenameOptions, type AppliedRename,
} from './graph/rename.js';
export {
  detectChanges, review, moduleOf,
  type Hunk, type DetectChangesResult, type DetectChangesOptions, type ChangedSymbol,
  type ChangedFile, type ReviewResult, type ReviewOptions,
} from './graph/changes.js';

export { doctor, formatReport, type DoctorReport, type Check } from './doctor.js';

export { tokenize, tokenSet, stem, fold, TOKENIZER_VERSION, TOKENIZER_SCRIPTS }
  from './util/tokenize.js';
export { nodeId, contentHash, shortHash } from './util/ids.js';
export { canonicalizePath, samePath, storeDirFor, globalDir, registryPath, PLUGIN_DIR_NAME } from './util/paths.js';
export { log, failOpen, logFilePath } from './util/log.js';
