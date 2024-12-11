import * as path from 'path';
import * as fs from 'fs';
import { debug, error, initializeLogging } from './logUtils';
import { readFile, fileExists, getWorkspacePath } from './fileUtils';

const CHANNEL = 'FigureUtils';
initializeLogging(CHANNEL);

/**
 * Extract figure paths from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of relative paths to figures
 */
export async function extractFigurePathsFromLatex(latexFile: string): Promise<string[]> {
    const figurePaths: string[] = [];
    
    try {
        const latexDir = path.dirname(latexFile);
        let graphicspaths = [latexDir]; // Start with the directory of the LaTeX file

        // Regular expressions to match figure inclusion commands and graphicspath
        const figurePatterns = [
            /\\includegraphics(?:\[.*?\])?\{(.+?)\}/g,
            /\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}/g
        ];
        const graphicspathPattern = /\\graphicspath\s*\{(.+?)\}/g;

        // Read file content
        const content = await readFile(latexFile);

        // Find all graphicspaths
        let graphicspathMatch;
        while ((graphicspathMatch = graphicspathPattern.exec(content)) !== null) {
            const pathStr = graphicspathMatch[1].trim();
            const paths = [pathStr.replace(/[{}]/g, '')]; // Remove braces
            
            for (const p of paths) {
                const normalizedPath = path.normalize(
                    path.join(latexDir, p.replace(/^\/+|\/+$/g, ''))
                );
                graphicspaths.push(normalizedPath);
                debug(CHANNEL, `Added graphicspath: ${normalizedPath}`);
            }
        }

        debug(CHANNEL, `Graphicspaths: ${graphicspaths.join(', ')}`);

        // Find all matches in the content for both patterns
        for (const pattern of figurePatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const figPath = match[1];
                for (const basePath of graphicspaths) {
                    const normPath = path.normalize(path.join(basePath, figPath));
                    // Try with common extensions if no extension is provided
                    const extensions = figPath.includes('.') ? [''] : ['.pdf', '.png', '.jpg', '.jpeg'];
                    
                    for (const ext of extensions) {
                        const pathToCheck = normPath + ext;
                        const relPath = path.relative(latexDir, pathToCheck);
                        if (await fileExists(relPath)) {
                            figurePaths.push(relPath);
                            debug(CHANNEL, `Found figure: ${relPath}`);
                            break;
                        }
                    }
                }
            }
        }

        debug(CHANNEL, `Found figures: ${figurePaths.join(', ')}`);
        return figurePaths;

    } catch (err) {
        error(CHANNEL, `Error extracting figure paths: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}

/**
 * Extract TikZ pictures with their labels from a LaTeX file
 * @param latexFile Path to the LaTeX file
 * @returns Array of [label, tikzpictures] tuples
 */
export async function extractTikzpicturesWithLabels(latexFile: string): Promise<[string, string[]][]> {
    try {
        const content = await readFile(latexFile);

        // Regular expressions to match figure environments and tikzpictures
        const figurePattern = /\\begin{figure}.*?\\label\{(.*?)\}.*?\\end{figure}/gs;
        const tikzPattern = /\\begin{tikzpicture}.*?\\end{tikzpicture}/gs;

        const labeledTikzpictures: [string, string[]][] = [];
        
        let figureMatch;
        while ((figureMatch = figurePattern.exec(content)) !== null) {
            const figureContent = figureMatch[0];
            const label = figureMatch[1];
            
            // Find all tikzpictures in this figure
            const tikzMatches = [...figureContent.matchAll(tikzPattern)].map(match => match[0]);
            
            if (tikzMatches.length > 0) {
                labeledTikzpictures.push([label, tikzMatches]);
                debug('FigureUtils', `Found TikZ picture with label: ${label}`);
            }
        }

        return labeledTikzpictures;
    } catch (err) {
        error('FigureUtils', `Error extracting TikZ pictures: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
}
