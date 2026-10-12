type HighstockModule = typeof import("highcharts/highstock");
type HighchartsModule = typeof import("highcharts");

let highstockPromise: Promise<HighstockModule> | null = null;

function normalizeModule<T extends object>(module: T) {
    const candidate = module as T & { default?: T };
    return candidate.default ?? module;
}

export function loadHighstock(): Promise<HighstockModule> {
    highstockPromise ??= import("highcharts/highstock").then(async (module) => {
        const highstock = normalizeModule(module);
        await import("highcharts/modules/accessibility");
        return highstock;
    });
    return highstockPromise;
}

export function loadHighcharts(): Promise<HighchartsModule> {
    return loadHighstock() as unknown as Promise<HighchartsModule>;
}

