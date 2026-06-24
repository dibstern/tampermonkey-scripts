// ==UserScript==
// @name         Google Slides: Copy Current Slide as Markdown
// @author       dibstern
// @namespace    https://github.com/dibstern/tampermonkey-scripts
// @version      0.1.2
// @description  Converts visible text on the currently active Google Slide to Markdown and copies it.
// @match        https://docs.google.com/presentation/d/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(() => {
    const BUTTON_ID = "copy-current-google-slide-as-markdown";

    function getPresentationId() {
        const match = location.pathname.match(/\/presentation\/d\/([^/]+)/);
        return match?.[1] ?? null;
    }

    function getCurrentSlidePageId() {
        // Typical hash: #slide=id.g2f3abcd_0_123 or #slide=id.p
        const match = location.hash.match(/slide=id\.([^&]+)/);
        return match?.[1] ?? null;
    }

    function getSvgExportUrl(presentationId, pageId) {
        return `https://docs.google.com/presentation/d/${presentationId}/export/svg?id=${presentationId}&pageid=${encodeURIComponent(pageId)}`;
    }

    async function fetchCurrentSlideSvg() {
        const presentationId = getPresentationId();
        const pageId = getCurrentSlidePageId();

        if (!presentationId) {
            throw new Error("Could not find the Google Slides presentation ID in the URL.");
        }

        if (!pageId) {
            throw new Error("Could not find the active slide ID. Click the slide thumbnail, then try again.");
        }

        const url = getSvgExportUrl(presentationId, pageId);

        const response = await fetch(url, {
            method: "GET",
            credentials: "same-origin",
            redirect: "follow",
        });

        const text = await response.text();

        if (!response.ok || !text.trim().startsWith("<svg")) {
            throw new Error(
                `Could not fetch slide SVG. Status: ${response.status}. ` +
                "This may happen if the deck is still loading or your Workspace permissions block export."
            );
        }

        return text;
    }

    function normaliseText(text) {
        return text
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+/g, " ")
            .replace(/\s+\n/g, "\n")
            .trim();
    }

    function getFontSize(el) {
        const direct = el.getAttribute("font-size");
        if (direct) return parseFloat(direct);

        const styled = el.getAttribute("style")?.match(/font-size:\s*([\d.]+)/i)?.[1];
        if (styled) return parseFloat(styled);

        const computed = window.getComputedStyle(el).fontSize;
        if (computed) return parseFloat(computed);

        const textParent = el.closest("text");
        if (textParent && textParent !== el) return getFontSize(textParent);

        return 12;
    }

    function joinRunsIntoLine(runs) {
        const sorted = [...runs].sort((a, b) => a.x - b.x);

        let output = "";
        let previous = null;

        for (const run of sorted) {
            const text = run.text.replace(/\s+/g, " ");
            if (!text.trim()) continue;

            if (previous) {
                const previousEnd = previous.x + previous.width;
                const gap = run.x - previousEnd;
                const gapLooksLikeSpace = gap > Math.max(3, run.fontSize * 0.25);

                if (
                    output &&
                    gapLooksLikeSpace &&
                    !output.endsWith(" ") &&
                    !text.startsWith(" ")
                ) {
                    output += " ";
                }
            }

            output += text;
            previous = run;
        }

        return normaliseText(output);
    }

    function groupRunsByVisualLine(runs) {
        const sorted = [...runs].sort((a, b) => a.centerY - b.centerY || a.x - b.x);
        const lines = [];

        for (const run of sorted) {
            const last = lines[lines.length - 1];
            const tolerance = Math.max(4, run.fontSize * 0.55);

            if (last && Math.abs(last.centerY - run.centerY) <= tolerance) {
                last.runs.push(run);
                last.centerY = (last.centerY + run.centerY) / 2;
                last.fontSize = Math.max(last.fontSize, run.fontSize);
            } else {
                lines.push({
                    centerY: run.centerY,
                    fontSize: run.fontSize,
                    runs: [run],
                });
            }
        }

        return lines
            .map((line) => {
            const text = joinRunsIntoLine(line.runs);
            const x = Math.min(...line.runs.map((r) => r.x));
            const y = Math.min(...line.runs.map((r) => r.y));
            const fontSize = Math.max(...line.runs.map((r) => r.fontSize));

            return { text, x, y, fontSize };
        })
            .filter((line) => line.text);
    }

    function decodeXmlEntities(text) {
        return String(text)
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
            .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
                     String.fromCodePoint(parseInt(hex, 16))
                    )
            .replace(/&#(\d+);/g, (_, dec) =>
                     String.fromCodePoint(parseInt(dec, 10))
                    )
            .replace(/&nbsp;/g, " ")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");
    }

    function stripSvgTags(fragment) {
        return fragment.replace(/<[^>]*>/g, "");
    }

    function parseSvgStyle(style) {
        const result = {};

        for (const part of String(style || "").split(";")) {
            const [rawKey, ...rawValue] = part.split(":");
            if (!rawKey || !rawValue.length) continue;

            result[rawKey.trim().toLowerCase()] = rawValue.join(":").trim();
        }

        return result;
    }

    function parseSvgAttributes(rawAttributes) {
        const attrs = {};

        String(rawAttributes || "").replace(
            /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g,
            (_, name, _quoted, doubleValue, singleValue) => {
                attrs[name.toLowerCase()] = decodeXmlEntities(doubleValue ?? singleValue ?? "");
                return "";
            }
        );

        const styleAttrs = parseSvgStyle(attrs.style);
        for (const [key, value] of Object.entries(styleAttrs)) {
            if (!(key in attrs)) attrs[key] = value;
        }

        return attrs;
    }

    function hasOwn(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function firstNumber(value, fallback = 0) {
        const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
        return match ? parseFloat(match[0]) : fallback;
    }

    function readSvgLength(attrs, name, fallback = 0, fontSize = 12) {
        if (!attrs || !hasOwn(attrs, name)) return fallback;

        const value = String(attrs[name]).trim();
        const number = firstNumber(value, fallback);

        if (value.endsWith("em")) return number * fontSize;
        if (value.endsWith("rem")) return number * fontSize;

        return number;
    }

    function readSvgFontSize(attrs, fallback = 12) {
        if (!attrs) return fallback;

        const value = attrs["font-size"];
        if (!value) return fallback;

        return firstNumber(value, fallback);
    }

    function approximateSvgTextWidth(text, fontSize) {
        // Good enough for line ordering/gap detection. This is not used for visual output.
        return [...String(text)].length * fontSize * 0.55;
    }

    function applySvgTransformToPoint(x, y, transform) {
        let nextX = x;
        let nextY = y;
        let scale = 1;

        const commands = String(transform || "").matchAll(/(\w+)\(([^)]*)\)/g);

        for (const [, command, rawArgs] of commands) {
            const nums = rawArgs
            .split(/[\s,]+/)
            .map((n) => parseFloat(n))
            .filter(Number.isFinite);

            if (command === "translate") {
                nextX += nums[0] ?? 0;
                nextY += nums[1] ?? 0;
                continue;
            }

            if (command === "scale") {
                const sx = nums[0] ?? 1;
                const sy = nums[1] ?? sx;
                nextX *= sx;
                nextY *= sy;
                scale *= sy;
                continue;
            }

            if (command === "matrix" && nums.length >= 6) {
                const [a, b, c, d, e, f] = nums;
                const oldX = nextX;
                const oldY = nextY;

                nextX = a * oldX + c * oldY + e;
                nextY = b * oldX + d * oldY + f;
                scale *= Math.sqrt(a * a + b * b) || 1;
            }
        }

        return { x: nextX, y: nextY, scale };
    }

    function plainTextFromSvgFragment(fragment) {
        return normaliseText(decodeXmlEntities(stripSvgTags(fragment)));
    }

    function extractLinesFromSvg(svgText) {
        const allLines = [];
        const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;

        let textMatch;

        while ((textMatch = textRegex.exec(svgText)) !== null) {
            const parentAttrs = parseSvgAttributes(textMatch[1]);
            const innerSvg = textMatch[2];

            const parentFontSize = readSvgFontSize(parentAttrs, 12);
            const parentX = readSvgLength(parentAttrs, "x", 0, parentFontSize);
            const parentY = readSvgLength(parentAttrs, "y", 0, parentFontSize);
            const parentTransform = parentAttrs.transform || "";

            const runs = [];
            const tspanRegex = /<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi;

            let tspanMatch;
            let foundTspan = false;
            let currentX = parentX;
            let currentY = parentY;
            let currentFontSize = parentFontSize;

            while ((tspanMatch = tspanRegex.exec(innerSvg)) !== null) {
                foundTspan = true;

                const childAttrs = parseSvgAttributes(tspanMatch[1]);
                const mergedAttrs = { ...parentAttrs, ...childAttrs };

                const text = plainTextFromSvgFragment(tspanMatch[2]);
                if (!text) continue;

                const fontSize = readSvgFontSize(mergedAttrs, currentFontSize);

                let x = hasOwn(childAttrs, "x")
                ? readSvgLength(childAttrs, "x", currentX, fontSize)
                : currentX;

                let y = hasOwn(childAttrs, "y")
                ? readSvgLength(childAttrs, "y", currentY, fontSize)
                : currentY;

                if (hasOwn(childAttrs, "dx")) {
                    x += readSvgLength(childAttrs, "dx", 0, fontSize);
                }

                if (hasOwn(childAttrs, "dy")) {
                    y += readSvgLength(childAttrs, "dy", 0, fontSize);
                }

                const combinedTransform = [parentTransform, childAttrs.transform]
                .filter(Boolean)
                .join(" ");

                const transformed = applySvgTransformToPoint(x, y, combinedTransform);
                const transformedFontSize = fontSize * transformed.scale;
                const width = approximateSvgTextWidth(text, transformedFontSize);

                runs.push({
                    text,
                    x: transformed.x,
                    y: transformed.y - transformedFontSize,
                    centerY: transformed.y - transformedFontSize / 2,
                    width,
                    height: transformedFontSize,
                    fontSize: transformedFontSize,
                });

                currentX = x + approximateSvgTextWidth(text, fontSize);
                currentY = y;
                currentFontSize = fontSize;
            }

            if (!foundTspan) {
                const text = plainTextFromSvgFragment(innerSvg);

                if (text) {
                    const transformed = applySvgTransformToPoint(parentX, parentY, parentTransform);
                    const transformedFontSize = parentFontSize * transformed.scale;

                    runs.push({
                        text,
                        x: transformed.x,
                        y: transformed.y - transformedFontSize,
                        centerY: transformed.y - transformedFontSize / 2,
                        width: approximateSvgTextWidth(text, transformedFontSize),
                        height: transformedFontSize,
                        fontSize: transformedFontSize,
                    });
                }
            }

            allLines.push(...groupRunsByVisualLine(runs));
        }

        return allLines.sort((a, b) => a.y - b.y || a.x - b.x);
    }

    function median(values) {
        if (!values.length) return 12;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    function looksLikeBullet(text) {
        return text.match(/^[•●○◦▪▫■□]\s*(.+)$/);
    }

    function looksLikeNumberedList(text) {
        return text.match(/^(\d+|[a-zA-Z])[.)]\s+(.+)$/);
    }

    function lineIndentLevel(line, bulletMinX) {
        if (!Number.isFinite(bulletMinX)) return 0;
        return Math.max(0, Math.round((line.x - bulletMinX) / 28));
    }

    function dominantFontSize(values) {
        if (!values.length) return 12;

        const counts = new Map();

        for (const value of values) {
            if (!Number.isFinite(value)) continue;

            const rounded = Math.round(value * 10) / 10;
            counts.set(rounded, (counts.get(rounded) || 0) + 1);
        }

        let bestValue = null;
        let bestCount = -1;

        for (const [value, count] of counts.entries()) {
            if (
                count > bestCount ||
                (count === bestCount && (bestValue === null || value < bestValue))
            ) {
                bestValue = value;
                bestCount = count;
            }
        }

        return bestValue ?? median(values);
    }

    function listIndentLevelForLine(line, listLines) {
        const sameShapeLines = listLines.filter((candidate) =>
                                                candidate.shapeOrder === line.shapeOrder
                                               );

        const scope = sameShapeLines.length ? sameShapeLines : listLines;

        if (!scope.length) return 0;

        const minX = Math.min(...scope.map((candidate) => candidate.x));
        return Math.max(0, Math.round((line.x - minX) / 28));
    }

    function isProbablySectionHeading(line, text, bodyFontSize) {
        const fontWeight = line.fontWeight || 400;
        const isBold = fontWeight >= 650;
        const isBiggerThanBody = line.fontSize >= bodyFontSize * 1.15;
        const isShortEnough = text.length <= 120;

        // Avoid turning handles/channels/URLs into headings.
        const looksLikeHandleOrChannel = /^[@#]\S+/.test(text);

        return isBold && isBiggerThanBody && isShortEnough && !looksLikeHandleOrChannel;
    }

    function isProbablySmallLabel(line, text, bodyFontSize) {
        const fontWeight = line.fontWeight || 400;
        const isBold = fontWeight >= 650;
        const isBodySized = line.fontSize < bodyFontSize * 1.15;
        const endsWithColon = /:\s*$/.test(text);

        return isBold && isBodySized && endsWithColon && text.length <= 80;
    }

    function convertLinesToMarkdown(lines) {
        if (!lines.length) return "";

        const cleanLines = lines
        .map((line) => ({
            ...line,
            text: normaliseText(line.text),
        }))
        .filter((line) => line.text);

        const fontSizes = cleanLines
        .map((line) => line.fontSize)
        .filter(Number.isFinite);

        const maxFontSize = Math.max(...fontSizes, 12);

        // Body text is usually the most common non-title font size.
        const nonTitleFontSizes = fontSizes.filter((size) => size < maxFontSize * 0.85);
        const bodyFontSize = dominantFontSize(nonTitleFontSizes.length ? nonTitleFontSizes : fontSizes);

        const hasLargeTitle = maxFontSize >= bodyFontSize * 1.6;

        const listLines = cleanLines.filter((line) =>
                                            looksLikeBullet(line.text) || looksLikeNumberedList(line.text)
                                           );

        const markdown = [];
        let usedTitle = false;

        for (const line of cleanLines) {
            const text = line.text;

            const bullet = looksLikeBullet(text);
            if (bullet) {
                const indent = "  ".repeat(listIndentLevelForLine(line, listLines));
                markdown.push(`${indent}- ${bullet[1].trim()}`);
                continue;
            }

            const numbered = looksLikeNumberedList(text);
            if (numbered) {
                const indent = "  ".repeat(listIndentLevelForLine(line, listLines));
                markdown.push(`${indent}1. ${numbered[2].trim()}`);
                continue;
            }

            const isTitle =
                  !usedTitle &&
                  hasLargeTitle &&
                  line.fontSize >= maxFontSize * 0.85;

            if (isTitle) {
                markdown.push(`# ${text}`);
                usedTitle = true;
                continue;
            }

            if (isProbablySectionHeading(line, text, bodyFontSize)) {
                markdown.push(`## ${text}`);
                continue;
            }

            if (isProbablySmallLabel(line, text, bodyFontSize)) {
                markdown.push(`**${text}**`);
                continue;
            }

            markdown.push(text);
        }

        return tidyMarkdown(markdown);
    }

    function isMarkdownHeading(line) {
        return /^#{1,6}\s+/.test(line.trim());
    }

    function isMarkdownListItem(line) {
        return /^\s*(-|\d+\.)\s+/.test(line);
    }

    function isMarkdownSmallLabel(line) {
        return /^\*\*.+:\*\*$/.test(line.trim());
    }

    function pushBlankLine(output) {
        if (output.length && output[output.length - 1] !== "") {
            output.push("");
        }
    }

    function tidyMarkdown(lines) {
        const output = [];

        for (const rawLine of lines) {
            const line = String(rawLine || "").trimEnd();
            const trimmed = line.trim();

            if (!trimmed) continue;

            const previous = output.length
            ? output.slice().reverse().find((candidate) => candidate.trim())
            : null;

            if (previous) {
                const currentIsHeading = isMarkdownHeading(line);
                const previousIsHeading = isMarkdownHeading(previous);

                const currentIsList = isMarkdownListItem(line);
                const previousIsList = isMarkdownListItem(previous);

                const currentIsSmallLabel = isMarkdownSmallLabel(line);

                const needsBlankLine =
                      currentIsHeading ||
                      previousIsHeading ||
                      currentIsSmallLabel ||
                      (currentIsList && !previousIsList) ||
                      (!currentIsList && previousIsList);

                if (needsBlankLine) {
                    pushBlankLine(output);
                }
            }

            output.push(line);
        }

        return output
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim() + "\n";
    }

    function copyText(text) {
        if (typeof GM_setClipboard === "function") {
            GM_setClipboard(text, "text");
            return Promise.resolve();
        }

        return navigator.clipboard.writeText(text);
    }

    function showToast(message) {
        const toast = document.createElement("div");
        toast.textContent = message;
        toast.style.cssText = [
            "position:fixed",
            "right:16px",
            "bottom:64px",
            "padding:10px 12px",
            "background:#202124",
            "color:white",
            "font:13px/1.4 system-ui, sans-serif",
            "border-radius:8px",
            "z-index:2147483647",
            "box-shadow:0 4px 16px rgba(0,0,0,.25)",
        ].join(";");

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    ////////////// START
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function getActiveSlideRoot() {
        const pageId = getCurrentSlidePageId();

        if (!pageId) {
            throw new Error("Could not find the active slide ID in the URL hash.");
        }

        return document.getElementById(`editor-${pageId}`);
    }

    async function waitForActiveSlideRoot(timeoutMs = 3000) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const root = getActiveSlideRoot();

            if (root && root.querySelector("text")) {
                return root;
            }

            await sleep(100);
        }

        throw new Error("Could not find rendered text for the active slide. Click the slide canvas and try again.");
    }

    function parseInlineStyle(styleText) {
        const result = {};

        for (const part of String(styleText || "").split(";")) {
            const [rawKey, ...rawValue] = part.split(":");
            if (!rawKey || !rawValue.length) continue;

            result[rawKey.trim().toLowerCase()] = rawValue.join(":").trim();
        }

        return result;
    }

    function getSvgTextFontSize(textEl) {
        const style = parseInlineStyle(textEl.getAttribute("style"));
        const fromStyle = parseFloat(style["font-size"]);

        if (Number.isFinite(fromStyle)) return fromStyle;

        const computed = parseFloat(window.getComputedStyle(textEl).fontSize);
        return Number.isFinite(computed) ? computed : 12;
    }

    function getSvgTextFontWeight(textEl) {
        const style = parseInlineStyle(textEl.getAttribute("style"));
        const weight = style["font-weight"] || window.getComputedStyle(textEl).fontWeight || "400";

        if (weight === "bold") return 700;

        const parsed = parseInt(weight, 10);
        return Number.isFinite(parsed) ? parsed : 400;
    }

    function textElToRun(textEl) {
        const text = normaliseText(textEl.textContent || "");
        if (!text) return null;

        const rect = textEl.getBoundingClientRect();

        if (!rect || rect.width === 0 || rect.height === 0) {
            return null;
        }

        const fontSize = getSvgTextFontSize(textEl);
        const fontWeight = getSvgTextFontWeight(textEl);

        return {
            text,
            x: rect.left,
            y: rect.top,
            centerY: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
            fontSize,
            fontWeight,
        };
    }

    function shouldInsertSpaceBetweenRuns(previous, current) {
        const gap = current.x - (previous.x + previous.width);

        if (gap <= 0.75) return false;

        // Do not add a space before common closing punctuation.
        if (/^[,.;:!?%)]/.test(current.text)) return false;

        // Do not add a space after common opening punctuation.
        if (/[(]$/.test(previous.text)) return false;

        return true;
    }

    function joinDomRunsIntoLine(runs) {
        const sorted = [...runs].sort((a, b) => a.x - b.x);

        let output = "";
        let previous = null;

        for (const run of sorted) {
            if (!run.text) continue;

            if (
                previous &&
                output &&
                shouldInsertSpaceBetweenRuns(previous, run) &&
                !output.endsWith(" ") &&
                !run.text.startsWith(" ")
            ) {
                output += " ";
            }

            output += run.text;
            previous = run;
        }

        return normaliseText(output);
    }

    function groupDomRunsByVisualLine(runs) {
        const sorted = [...runs].sort((a, b) => a.centerY - b.centerY || a.x - b.x);
        const lines = [];

        for (const run of sorted) {
            const last = lines[lines.length - 1];

            // Use rendered pixel height, not source font-size, because the editor SVG is scaled.
            const tolerance = Math.max(3, run.height * 0.45);

            if (last && Math.abs(last.centerY - run.centerY) <= tolerance) {
                last.runs.push(run);
                last.centerY = (last.centerY + run.centerY) / 2;
            } else {
                lines.push({
                    centerY: run.centerY,
                    runs: [run],
                });
            }
        }

        return lines
            .map((line) => {
            const text = joinDomRunsIntoLine(line.runs);
            const x = Math.min(...line.runs.map((r) => r.x));
            const y = Math.min(...line.runs.map((r) => r.y));
            const fontSize = Math.max(...line.runs.map((r) => r.fontSize));
            const fontWeight = Math.max(...line.runs.map((r) => r.fontWeight));

            return { text, x, y, fontSize, fontWeight };
        })
            .filter((line) => line.text);
    }

    function getTextShapeRoots(root) {
        const directTextShapes = [...root.children].filter((child) =>
                                                           child.id &&
                                                           child.id.startsWith("editor-") &&
                                                           !child.id.endsWith("-bg") &&
                                                           child.querySelector &&
                                                           child.querySelector("text")
                                                          );

        if (directTextShapes.length) {
            return directTextShapes;
        }

        // Fallback: find top-level child under the active slide that owns each text node.
        const seen = new Set();
        const shapes = [];

        for (const textEl of [...root.querySelectorAll("text")]) {
            let node = textEl;

            while (node && node.parentElement && node.parentElement !== root) {
                node = node.parentElement;
            }

            if (
                node &&
                node.id &&
                node.id.startsWith("editor-") &&
                !node.id.endsWith("-bg") &&
                !seen.has(node)
            ) {
                seen.add(node);
                shapes.push(node);
            }
        }

        return shapes;
    }

    function extractLinesFromTextShape(shapeRoot, shapeOrder) {
        const paragraphEls = [...shapeRoot.querySelectorAll('[id*="-paragraph-"]')];

        const sourceBlocks = paragraphEls.length
        ? paragraphEls
        : [shapeRoot];

        const lines = [];

        for (const [paragraphOrder, block] of sourceBlocks.entries()) {
            const textEls = [...block.querySelectorAll("text")];

            const runs = textEls
            .map(textElToRun)
            .filter(Boolean);

            const blockLines = groupDomRunsByVisualLine(runs).map((line) => ({
                ...line,
                shapeOrder,
                paragraphOrder,
            }));

            lines.push(...blockLines);
        }

        return lines.sort((a, b) =>
                          a.y - b.y ||
                          a.x - b.x ||
                          a.paragraphOrder - b.paragraphOrder
                         );
    }

    function textShapeToBlock(shapeRoot, shapeOrder) {
        const lines = extractLinesFromTextShape(shapeRoot, shapeOrder);

        if (!lines.length) {
            return null;
        }

        const x = Math.min(...lines.map((line) => line.x));
        const y = Math.min(...lines.map((line) => line.y));
        const maxFontSize = Math.max(...lines.map((line) => line.fontSize));
        const maxFontWeight = Math.max(...lines.map((line) => line.fontWeight || 400));

        return {
            shapeRoot,
            shapeOrder,
            lines,
            x,
            y,
            maxFontSize,
            maxFontWeight,
            text: lines.map((line) => line.text).join("\n"),
        };
    }

    function sortBlocksByColumns(blocks) {
        if (!blocks.length) return [];

        const sortedByX = [...blocks].sort((a, b) =>
                                           a.x - b.x ||
                                           a.y - b.y ||
                                           a.shapeOrder - b.shapeOrder
                                          );

        const minX = Math.min(...sortedByX.map((block) => block.x));
        const maxX = Math.max(...sortedByX.map((block) => block.x));
        const xRange = Math.max(1, maxX - minX);

        // Large enough to group headers and body boxes in the same visual column,
        // small enough to keep left/middle/right columns separate.
        const columnTolerance = Math.max(32, xRange * 0.16);

        const columns = [];

        for (const block of sortedByX) {
            let bestColumn = null;
            let bestDistance = Infinity;

            for (const column of columns) {
                const distance = Math.abs(block.x - column.x);

                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestColumn = column;
                }
            }

            if (!bestColumn || bestDistance > columnTolerance) {
                columns.push({
                    x: block.x,
                    blocks: [block],
                });
            } else {
                bestColumn.blocks.push(block);
                bestColumn.x = median(bestColumn.blocks.map((b) => b.x));
            }
        }

        return columns
            .sort((a, b) => a.x - b.x)
            .flatMap((column) =>
                     column.blocks.sort((a, b) =>
                                        a.y - b.y ||
                                        a.x - b.x ||
                                        a.shapeOrder - b.shapeOrder
                                       )
                    );
    }

    function sortBlocksForReadingOrder(root, blocks) {
        if (!blocks.length) return [];

        const slideRect = root.getBoundingClientRect();
        const topY = Math.min(...blocks.map((block) => block.y));
        const maxFontSize = Math.max(...blocks.map((block) => block.maxFontSize));

        // Pull a large top title out of the column flow.
        const titleBlocks = blocks.filter((block) =>
                                          block.maxFontSize >= maxFontSize * 0.85 &&
                                          block.y <= topY + slideRect.height * 0.25
                                         );

        const titleSet = new Set(titleBlocks);
        const bodyBlocks = blocks.filter((block) => !titleSet.has(block));

        return [
            ...titleBlocks.sort((a, b) =>
                                a.y - b.y ||
                                a.x - b.x ||
                                a.shapeOrder - b.shapeOrder
                               ),
            ...sortBlocksByColumns(bodyBlocks),
        ];
    }

    function extractLinesFromActiveSlideDom(root) {
        const shapeRoots = getTextShapeRoots(root);

        const blocks = shapeRoots
        .map((shapeRoot, shapeOrder) => textShapeToBlock(shapeRoot, shapeOrder))
        .filter(Boolean);

        const orderedBlocks = sortBlocksForReadingOrder(root, blocks);

        console.log(
            "Ordered slide text blocks:",
            orderedBlocks.map((block) => ({
                x: Math.round(block.x),
                y: Math.round(block.y),
                maxFontSize: block.maxFontSize,
                text: block.text,
            }))
        );

        return orderedBlocks.flatMap((block) => block.lines);
    }

    async function copyCurrentSlideAsMarkdown() {
        const root = await waitForActiveSlideRoot();
        const lines = extractLinesFromActiveSlideDom(root);

        console.log("Extracted slide lines:", lines);

        const markdown = convertLinesToMarkdown(lines);

        if (!markdown.trim()) {
            throw new Error("No visible text found on the current slide.");
        }

        await copyText(markdown);
        console.log("Current slide as Markdown:\n\n" + markdown);
        showToast("Copied current slide as Markdown");
    }
    /////////// END

    function installButton() {
        if (document.getElementById(BUTTON_ID)) return;

        const button = document.createElement("button");
        button.id = BUTTON_ID;
        button.type = "button";
        button.textContent = "Copy slide MD";
        button.title = "Copy current Google Slide text as Markdown. Shortcut: Alt+Shift+M";

        button.style.cssText = [
            "position:fixed",
            "right:16px",
            "bottom:16px",
            "z-index:2147483647",
            "padding:8px 10px",
            "border:0",
            "border-radius:8px",
            "background:#1a73e8",
            "color:white",
            "font:13px system-ui, sans-serif",
            "cursor:pointer",
            "box-shadow:0 2px 8px rgba(0,0,0,.25)",
        ].join(";");

        button.addEventListener("click", async () => {
            try {
                await copyCurrentSlideAsMarkdown();
            } catch (error) {
                console.error(error);
                showToast(error.message);
            }
        });

        document.body.appendChild(button);
    }

    document.addEventListener("keydown", async (event) => {
        if (event.altKey && event.shiftKey && event.code === "KeyM") {
            event.preventDefault();

            try {
                await copyCurrentSlideAsMarkdown();
            } catch (error) {
                console.error(error);
                showToast(error.message);
            }
        }
    });

    installButton();
    setInterval(installButton, 3000);
})();