import type { EventBusService } from "../events";
import type { AppConfig } from "../utils/config";
import { DocumentManagementClient } from "./DocumentManagementClient";
import { DocumentManagementService } from "./DocumentManagementService";
import { createDocumentStore } from "./DocumentStoreFactory";
import type { IDocumentManagement } from "./trpc/interfaces";

export * from "./DocumentManagementClient";
export * from "./DocumentManagementService";
export * from "./DocumentStore";
export * from "./DocumentStoreFactory";
export * from "./errors";
export * from "./IDocumentStore";
export * from "./SqliteDocumentStore";
export * from "./trpc/interfaces";

/** Factory to create a document management implementation */
export async function createDocumentManagement(options: {
  eventBus: EventBusService;
  serverUrl?: string;
  appConfig: AppConfig;
}) {
  if (options.serverUrl) {
    const client = new DocumentManagementClient(options.serverUrl);
    await client.initialize();
    return client as IDocumentManagement;
  }

  const store = await createDocumentStore(options.appConfig);
  await store.initialize();

  const service = new DocumentManagementService(
    options.eventBus,
    options.appConfig,
    store,
  );
  await service.initialize();
  return service as IDocumentManagement;
}

/**
 * Creates and initializes a local DocumentManagementService instance.
 * Use this only when constructing an in-process PipelineManager (worker path).
 */
export async function createLocalDocumentManagement(
  eventBus: EventBusService,
  appConfig: AppConfig,
) {
  const store = await createDocumentStore(appConfig);
  await store.initialize();

  const service = new DocumentManagementService(eventBus, appConfig, store);
  await service.initialize();
  return service;
}
