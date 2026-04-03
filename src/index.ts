import AstroBox, { PluginUINode } from "astrobox-plugin-sdk";

const DEFAULT_PACKAGE = "me.localhosts.schedule";

let syncStatus = "待发送";

let callbackIds: {
    pickAndSyncId: string;
} | null = null;

function ensureCallbackIds(): {
    pickAndSyncId: string;
} {
    if (callbackIds) {
        return callbackIds;
    }

    callbackIds = {
        pickAndSyncId: AstroBox.native.regNativeFun(async () => {
            await pickAndSyncCourseFile();
        }),
    };

    return callbackIds;
}

function toErrorText(err: any): string {
    if (err?.message && typeof err.message === "string") {
        return err.message;
    }

    const plain = String(err ?? "").trim();
    if (plain) {
        return plain;
    }

    return "未知错误";
}

function safeJsonParse(text: string): any | null {
    try {
        return JSON.parse(text);
    } catch (_err) {
        return null;
    }
}

function isWakeupScheduleFile(path: string): boolean {
    return path.toLowerCase().endsWith(".wakeup_schedule");
}

function parseWakeupScheduleParts(content: string): any[] {
    const text = content.trim();
    const parts: any[] = [];

    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;
    let startPos = 0;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === "\\") {
            escapeNext = true;
            continue;
        }

        if (char === "\"") {
            inString = !inString;
            continue;
        }

        if (inString) {
            continue;
        }

        if (char === "{") {
            if (braceCount === 0 && bracketCount === 0) {
                startPos = i;
            }
            braceCount += 1;
        } else if (char === "}") {
            braceCount -= 1;
        } else if (char === "[") {
            if (braceCount === 0 && bracketCount === 0) {
                startPos = i;
            }
            bracketCount += 1;
        } else if (char === "]") {
            bracketCount -= 1;
        }

        if (braceCount === 0 && bracketCount === 0 && (char === "}" || char === "]")) {
            const jsonStr = text.slice(startPos, i + 1);
            try {
                parts.push(JSON.parse(jsonStr));
            } catch (err) {
                console.warn("parse wakeup segment failed:", err);
            }
        }
    }

    return parts;
}

function isValidTimeEntry(item: any): boolean {
    return !(item?.startTime === "00:00" && item?.endTime === "00:00");
}

function removeFields(parts: any[]): any[] {
    const fieldsToRemove = new Set([
        "color",
        "tableId",
        "courseTextColor",
        "textColor",
        "strokeColor",
        "widgetCourseTextColor",
        "widgetStrokeColor",
        "widgetTextColor",
        "level",
        "ownTime",
    ]);

    const result: any[] = [];
    let globalStartDate = "";

    for (const part of parts) {
        if (part && typeof part === "object" && !Array.isArray(part) && typeof part.startDate === "string" && part.startDate.trim()) {
            globalStartDate = part.startDate;
            break;
        }
    }

    for (let idx = 0; idx < parts.length; idx += 1) {
        if (idx === 0 || idx === 2) {
            continue;
        }

        const item = parts[idx];
        if (!Array.isArray(item)) {
            continue;
        }

        const cleanedList: any[] = [];
        for (const obj of item) {
            if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
                cleanedList.push(obj);
                continue;
            }

            if (idx === 3) {
                const courseItem: any = {};
                if ("id" in obj) {
                    courseItem.id = obj.id;
                }
                if ("courseName" in obj) {
                    courseItem.courseName = obj.courseName;
                }
                if (Object.keys(courseItem).length > 0) {
                    cleanedList.push(courseItem);
                }
                continue;
            }

            const cleaned: any = {};
            for (const [key, value] of Object.entries(obj)) {
                if (!fieldsToRemove.has(key)) {
                    cleaned[key] = value;
                }
            }

            if (cleaned.type === 0) {
                delete cleaned.type;
            }

            if ("node" in cleaned && "startTime" in cleaned && "endTime" in cleaned) {
                if (isValidTimeEntry(cleaned)) {
                    cleanedList.push(cleaned);
                }
            } else {
                cleanedList.push(cleaned);
            }
        }

        result.push(cleanedList);
    }

    if (globalStartDate) {
        result.push({ startDate: globalStartDate });
    }

    return result;
}

function trimTrailingDefaults(row: any[], defaults: any[]): any[] {
    const trimmed = [...row];
    while (trimmed.length > 0 && defaults.includes(trimmed[trimmed.length - 1])) {
        trimmed.pop();
    }
    return trimmed;
}

function collectStringFrequency(obj: any, counter: Map<string, number>): void {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const value of Object.values(obj)) {
            collectStringFrequency(value, counter);
        }
        return;
    }

    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectStringFrequency(item, counter);
        }
        return;
    }

    if (typeof obj === "string") {
        counter.set(obj, (counter.get(obj) ?? 0) + 1);
    }
}

function applyStringDictionary(obj: any, dictionary: Map<string, string>): any {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const mapped: any = {};
        for (const [key, value] of Object.entries(obj)) {
            mapped[key] = applyStringDictionary(value, dictionary);
        }
        return mapped;
    }

    if (Array.isArray(obj)) {
        return obj.map((item) => applyStringDictionary(item, dictionary));
    }

    if (typeof obj === "string") {
        return dictionary.get(obj) ?? obj;
    }

    return obj;
}

function compressJson(data: any[]): any {
    const timeItems = Array.isArray(data[0]) ? data[0] : [];
    const courseItems = Array.isArray(data[1]) ? data[1] : [];
    const scheduleItems = Array.isArray(data[2]) ? data[2] : [];
    const globalStartDate = data[3] && typeof data[3] === "object" ? data[3].startDate || "" : "";

    const compactTime = timeItems.map((item: any) =>
        trimTrailingDefaults([item?.node, item?.startTime, item?.endTime, item?.timeTable ?? ""], ["", null])
    );

    const compactCourses = courseItems.map((item: any) =>
        trimTrailingDefaults([item?.id, item?.courseName ?? ""], ["", null])
    );

    const compactSchedule: any[] = [];
    const compactType: Array<[number, any]> = [];

    for (let idx = 0; idx < scheduleItems.length; idx += 1) {
        const item = scheduleItems[idx] ?? {};
        const row = [
            item.day,
            item.startWeek,
            item.endWeek,
            item.startNode,
            item.id,
            item.room ?? "",
            item.teacher ?? "",
            item.step ?? 1,
        ];

        compactSchedule.push(trimTrailingDefaults(row, ["", null, 1]));

        const typeValue = item.type ?? 0;
        if (typeValue !== 0 && typeValue !== null) {
            compactType.push([idx, typeValue]);
        }
    }

    let compressed: any = {
        v: 6,
        t: compactTime,
        c: compactCourses,
        s: compactSchedule,
    };

    if (globalStartDate) {
        compressed.d = globalStartDate;
    }

    if (compactType.length > 0) {
        compressed.y = compactType;
    }

    const stringCounter = new Map<string, number>();
    collectStringFrequency(compressed, stringCounter);

    const frequentStrings = Array.from(stringCounter.entries())
        .filter(([text, count]) => count >= 3 && text.length >= 4)
        .sort((a, b) => {
            const scoreA = a[0].length * a[1];
            const scoreB = b[0].length * b[1];
            if (scoreA !== scoreB) {
                return scoreB - scoreA;
            }
            if (a[0].length !== b[0].length) {
                return b[0].length - a[0].length;
            }
            return a[0].localeCompare(b[0]);
        })
        .map(([text]) => text);

    if (frequentStrings.length > 0) {
        const tokenMap = new Map<string, string>();
        for (let idx = 0; idx < frequentStrings.length; idx += 1) {
            tokenMap.set(frequentStrings[idx], `~${idx.toString(16)}`);
        }

        compressed = applyStringDictionary(compressed, tokenMap);
        compressed.x = frequentStrings;
    }

    return compressed;
}

function buildScheduleObjectForSync(text: string, sourcePath: string): any {
    if (isWakeupScheduleFile(sourcePath)) {
        const parts = parseWakeupScheduleParts(text);
        if (parts.length === 0) {
            throw new Error(".wakeup_schedule 文件解析失败");
        }
        const cleanedData = removeFields(parts);
        return compressJson(cleanedData);
    }

    const scheduleObject = safeJsonParse(text);
    if (!scheduleObject || typeof scheduleObject !== "object") {
        throw new Error("文件内容不是有效 JSON");
    }

    return scheduleObject;
}

function makePayload(scheduleObject: any, format: string): string {
    return JSON.stringify({
        type: "schedule.sync.payload",
        source: "astrobox-plugin",
        format,
        data: scheduleObject,
    });
}

function buildNodes(): PluginUINode[] {
    const ids = ensureCallbackIds();

    return [
        {
            node_id: "guideText",
            visibility: true,
            disabled: false,
            content: {
                type: "Text",
                value:
                    "首先需要在WakeUP课程表上导出备份文件，然后在AstroBox上连接手表，并打开快应用，点击同步按钮，然后选中导出的备份文件，就可以开始使用了",
            },
        },
        {
            node_id: "syncStatus",
            visibility: true,
            disabled: false,
            content: {
                type: "Text",
                value: `同步状态：${syncStatus}`,
            },
        },
        {
            node_id: "btnSend",
            visibility: true,
            disabled: false,
            content: {
                type: "Button",
                value: {
                    primary: true,
                    text: "同步",
                    callback_fun_id: ids.pickAndSyncId,
                },
            },
        },
    ];
}

function renderSettingsUi(): void {
    try {
        AstroBox.ui.updatePluginSettingsUI(buildNodes());
    } catch (err: any) {
        console.warn("renderSettingsUi failed:", err);
    }
}

async function sendScheduleObject(scheduleObject: any, format: string): Promise<void> {

    const payload = makePayload(scheduleObject, format);
    try {
        await AstroBox.interconnect.sendQAICMessage(DEFAULT_PACKAGE, payload);
    } catch (err: any) {
        throw new Error(`发送到快应用失败：${toErrorText(err)}`);
    }

    // 发送成功即视为同步成功，后续步骤异常不再覆盖为失败。
    syncStatus = "同步成功";
    renderSettingsUi();
}

async function readScheduleText(path: string, preferLen?: number): Promise<string> {
    const len = preferLen && preferLen > 0 ? preferLen : 1024 * 1024;
    let raw: Uint8Array | string;
    try {
        raw = await AstroBox.filesystem.readFile(path, {
            len,
            decode_text: true,
        });
    } catch (err: any) {
        throw new Error(`读取文件失败：${toErrorText(err)}`);
    }

    return typeof raw === "string" ? raw : "";
}

async function pickAndSyncCourseFile(): Promise<void> {
    syncStatus = "正在选择文件...";
    renderSettingsUi();

    try {
        let picked;
        try {
            picked = await AstroBox.filesystem.pickFile({
                decode_text: true,
                encoding: "utf-8",
            });
        } catch (err: any) {
            throw new Error(`选择文件失败：${toErrorText(err)}`);
        }

        if (!isWakeupScheduleFile(picked.path)) {
            throw new Error("请选择 .wakeup_schedule 文件");
        }

        syncStatus = "正在同步...";
        renderSettingsUi();

        const text = await readScheduleText(picked.path, picked.text_len || picked.size);

        const scheduleObject = buildScheduleObjectForSync(text, picked.path);

        await sendScheduleObject(scheduleObject, "wakeup_schedule.compressed.v6");
    } catch (err: any) {
        syncStatus = `同步失败：${toErrorText(err)}`;
        renderSettingsUi();
        console.warn("sync failed:", err);
    }
}

AstroBox.lifecycle.onLoad(() => {
    renderSettingsUi();

    console.log("Course sync plugin loaded");
});