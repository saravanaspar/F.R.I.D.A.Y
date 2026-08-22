/** Minimal model-catalog surface required by authentication flows. */
export interface AuthModelDescriptor {
  readonly id: string;
  readonly provider: string;
  readonly baseUrl?: string;
}

export interface ModelCatalogAccess {
  getModels(provider?: string): AuthModelDescriptor[];
}

let modelCatalogAccess: ModelCatalogAccess | undefined;

/** Inject the model catalog without coupling this runtime to a concrete model package. */
export function configureModelCatalogAccess(access: ModelCatalogAccess): void {
  modelCatalogAccess = access;
}

export function getProviderModels(provider: string): AuthModelDescriptor[] {
  if (!modelCatalogAccess) {
    throw new Error("Authentication runtime model catalog dependency is not configured");
  }
  return modelCatalogAccess.getModels(provider);
}
