// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

// Server-friendly EPUB parsing components (no DOM dependencies)
let fflate: any, XMLParser: any, htmlToText: any, nodeHtmlParser: any;

try {
  const fflateModule = await import("https://esm.sh/fflate@0.8.1");
  fflate = fflateModule;
  
  const xmlParserModule = await import("https://esm.sh/fast-xml-parser@4.3.4");
  XMLParser = xmlParserModule.XMLParser;
  
  const htmlToTextModule = await import("https://esm.sh/html-to-text@9.0.4");
  htmlToText = htmlToTextModule.htmlToText;
  
  const nodeHtmlParserModule = await import("https://esm.sh/node-html-parser@7.0.1");
  nodeHtmlParser = nodeHtmlParserModule.parse;
  
  console.log("✅ Server-friendly parsing libraries loaded successfully");
} catch (error) {
  console.warn("Failed to load parsing libraries, falling back to basic implementations");
  // Fallback implementations will be used
}

interface BookMetadata {
  title: string;
  author: string;
  language: string;
  originalFilename: string;
  side: 'foreign' | 'native';
}

interface ProcessedFile {
  data: Uint8Array;
  filename: string;
  originalSize: number;
  compressedSize: number;
}

// EPUB Content Interfaces
interface EpubContent {
  metadata: {
    title: string;
    author: string;
    language: string;
    identifier: string;
    publisher?: string;
    publishedDate?: string;
    description?: string;
    subject?: string[];
    rights?: string;
    source?: string;
  };
  structure: {
    totalChapters: number;
    totalPages?: number;
    estimatedReadingTime?: number;
    wordCount: number;
    tableOfContents: TocEntry[];
    spine: SpineItem[];
  };
  chapters: Chapter[];
  resources: {
    coverImage?: string;
    images: ImageResource[];
    stylesheets: string[];
    fonts: FontResource[];
  };
  parsing: {
    parsedAt: string;
    epubVersion: string;
    parser: string;
    errors?: string[];
    warnings?: string[];
  };
}

interface TocEntry {
  id: string;
  title: string;
  href: string;
  level: number;
  playOrder?: number;
  children?: TocEntry[];
}

interface Chapter {
  id: string;
  title: string;
  href: string;
  htmlContent: string;
  textContent: string;
  wordCount: number;
  order: number;
  level: number;
}

interface SpineItem {
  id: string;
  href: string;
  mediaType: string;
  linear: boolean;
  properties?: string[];
}

interface ImageResource {
  id: string;
  href: string;
  mediaType: string;
  base64?: string;
  storageUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
}

interface FontResource {
  id: string;
  href: string;
  mediaType: string;
  fontFamily: string;
  isObfuscated?: boolean;
}

// Enhanced ZIP file handling using fflate (4-8x faster than JSZip)
interface ZipFiles {
  [path: string]: Uint8Array;
}

function extractZipFiles(data: Uint8Array): ZipFiles {
  console.log(`Extracting ZIP with fflate (size: ${data.length} bytes)`);
  const startTime = performance.now();
  
  try {
    if (!fflate?.unzipSync) {
      throw new Error('fflate not available, falling back to basic ZIP handling');
    }
    
    // Use fflate.unzipSync for maximum performance
    const unzipped = fflate.unzipSync(data);
    const extractTime = performance.now() - startTime;
    
    console.log(`ZIP extracted in ${extractTime.toFixed(2)}ms (${Object.keys(unzipped).length} files)`);
    
    // Convert fflate output to our format
    const files: ZipFiles = {};
    for (const [path, fileData] of Object.entries(unzipped)) {
      files[path] = fileData as Uint8Array;
    }
    
    return files;
  } catch (error) {
    throw new Error(`ZIP extraction failed: ${error.message}`);
  }
}

// Enhanced XML parsing using fast-xml-parser (2-3x faster, immune to RegExp catastrophes)
let xmlParser: any;

if (XMLParser) {
  xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    ignoreNameSpace: false,
    removeNSPrefix: false,
    parseAttributeValue: true,
    parseTagValue: true,
    trimValues: true,
    parseTrueNumberOnly: false,
    arrayMode: false,
    alwaysCreateTextNode: false,
    isArray: (name: string, jpath: string, isLeafNode: boolean, isAttribute: boolean) => {
      // Handle arrays for manifest items, spine items, etc.
      return ['item', 'itemref', 'li', 'a', 'subject'].includes(name);
    }
  });
}

// Extract clean text for word counting and search (plain text)
function extractTextFromHtml(htmlContent: string): string {
  console.log(`Processing HTML content (${htmlContent.length} chars) for plain text extraction`);
  const startTime = performance.now();
  
  try {
    // Strip Project Gutenberg boilerplate first
    let cleanHtml = stripProjectGutenbergBoilerplate(htmlContent);
    
    // Use html-to-text for robust server-side HTML processing
    let textContent = '';
    if (htmlToText) {
      textContent = htmlToText(cleanHtml, {
        wordwrap: false,
        selectors: [
          // Skip structural and boilerplate elements
          { selector: 'head, script, style, meta, link', format: 'skip' },
          { selector: 'table.pg-boilerplate, .pg-boilerplate', format: 'skip' },
          { selector: '.toc, .table-of-contents', format: 'skip' },
          { selector: '.footer, .header, .navigation', format: 'skip' },
          { selector: '[height="0pt"], [width="0pt"]', format: 'skip' }, // Skip layout elements
          { selector: 'img', format: 'skip' }, // Skip images for plain text
          { selector: 'hr', format: 'skip' }, // Skip horizontal rules
          { selector: 'span[id]', format: 'skip' } // Skip anchor spans
        ],
        formatters: {
          'paragraph': (elem: any, walk: any, builder: any) => {
            walk(elem.children, builder);
            builder.addLineBreak();
          }
        }
      });
      console.log(`html-to-text processing completed successfully`);
    } else {
      // Enhanced fallback processing
      textContent = processHtmlFallback(cleanHtml);
      console.log(`Fallback regex processing completed`);
    }
    
    // Final cleanup and normalization
    const finalText = textContent
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    const processTime = performance.now() - startTime;
    console.log(`Plain text extraction completed in ${processTime.toFixed(2)}ms`);
    console.log(`Output: ${finalText.length} chars clean text`);
    
    return finalText;
  } catch (error) {
    console.error(`Plain text extraction failed: ${error.message}`);
    return processHtmlFallback(htmlContent);
  }
}

// Extract formatted HTML for frontend display (preserve meaningful formatting)
function extractFormattedHtml(htmlContent: string): string {
  console.log(`Processing HTML content (${htmlContent.length} chars) for formatted display`);
  const startTime = performance.now();
  
  try {
    // Strip Project Gutenberg boilerplate first
    let cleanHtml = stripProjectGutenbergBoilerplate(htmlContent);
    
    // Use manual processing to ensure clean HTML output for frontend
    const formattedContent = preserveBasicFormatting(cleanHtml);
    
    const processTime = performance.now() - startTime;
    console.log(`Formatted HTML extraction completed in ${processTime.toFixed(2)}ms`);
    return formattedContent;
  } catch (error) {
    console.error(`Formatted HTML extraction failed: ${error.message}`);
    return preserveBasicFormatting(htmlContent);
  }
}

// Enhanced fallback HTML processing
function processHtmlFallback(html: string): string {
  return html
    // Remove structural elements
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<head[^>]*>.*?<\/head>/gis, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<html[^>]*>/gi, '')
    .replace(/<\/html>/gi, '')
    .replace(/<body[^>]*>/gi, '')
    .replace(/<\/body>/gi, '')
    .replace(/<meta[^>]*\/?>/gi, '')
    .replace(/<link[^>]*\/?>/gi, '')
    .replace(/<img[^>]*\/?>/gi, '')
    .replace(/<hr[^>]*\/?>/gi, '')
    .replace(/<span[^>]*id[^>]*>.*?<\/span>/gi, '')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode entities
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&eacute;/gi, 'é')
    .replace(/&egrave;/gi, 'è')
    .replace(/&ecirc;/gi, 'ê')
    .replace(/&agrave;/gi, 'à')
    .replace(/&acirc;/gi, 'â')
    .replace(/&ccedil;/gi, 'ç')
    .replace(/&#(\d+);/g, (match, num) => String.fromCharCode(parseInt(num)))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Preserve basic formatting for frontend display - outputs clean, well-formed HTML
function preserveBasicFormatting(html: string): string {
  let result = html;
  
  // Step 1: Remove structural/layout elements completely
  result = result
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<head[^>]*>.*?<\/head>/gis, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<html[^>]*>/gi, '')
    .replace(/<\/html>/gi, '')
    .replace(/<body[^>]*>/gi, '')
    .replace(/<\/body>/gi, '')
    .replace(/<meta[^>]*\/?>/gi, '')
    .replace(/<link[^>]*\/?>/gi, '')
    .replace(/<img[^>]*\/?>/gi, '')
    .replace(/<hr[^>]*\/?>/gi, '')
    .replace(/<span[^>]*id[^>]*>[^<]*<\/span>/gi, '') // Remove anchor spans
    .replace(/<a[^>]*href[^>]*>[^<]*<\/a>/gi, '') // Remove links (keep content)
    .replace(/<br\s*\/?>/gi, ' '); // Convert breaks to spaces
  
  // Step 2: Decode HTML entities FIRST (before tag processing)
  result = result
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&eacute;/gi, 'é')
    .replace(/&egrave;/gi, 'è')
    .replace(/&ecirc;/gi, 'ê')
    .replace(/&agrave;/gi, 'à')
    .replace(/&acirc;/gi, 'â')
    .replace(/&ccedil;/gi, 'ç')
    .replace(/&uuml;/gi, 'ü')
    .replace(/&ouml;/gi, 'ö')
    .replace(/&auml;/gi, 'ä')
    .replace(/&#(\d+);/g, (match, num) => String.fromCharCode(parseInt(num)))
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&') // Do & last to avoid double-decoding
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  
  // Step 3: Clean and standardize formatting tags
  result = result
    .replace(/<b\b[^>]*>/gi, '<strong>')
    .replace(/<\/b>/gi, '</strong>')
    .replace(/<i\b[^>]*>/gi, '<em>')
    .replace(/<\/i>/gi, '</em>')
    .replace(/<u\b[^>]*>/gi, '<u>')
    .replace(/<\/u>/gi, '</u>');
  
  // Step 4: Handle font tags carefully (preserve content, convert large sizes to strong)
  result = result
    .replace(/<font[^>]*size\s*=\s*["']?([5-9]|[1-9][0-9])["']?[^>]*>/gi, '<strong>') // Large font = strong
    .replace(/<font[^>]*>/gi, '') // Remove other font opening tags
    .replace(/<\/font>/gi, '</strong>'); // Close font tags as strong (will be cleaned up later)
  
  // Step 5: Clean up paragraphs and remove layout attributes
  result = result
    .replace(/<p\b[^>]*>/gi, '<p>') // Clean paragraph opening tags
    .replace(/<div[^>]*>/gi, '') // Remove div opening tags
    .replace(/<\/div>/gi, '') // Remove div closing tags
    .replace(/<center[^>]*>/gi, '') // Remove center tags
    .replace(/<\/center>/gi, '');
  
  // Step 6: Remove any remaining layout/style tags but keep content
  result = result
    .replace(/<(?!\/?(strong|em|u|p)\b)[^>]*>/gi, ' ') // Remove all tags except formatting ones
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  // Step 7: Structure content into proper paragraphs
  // Split by multiple spaces or line breaks and wrap in paragraphs
  const sentences = result.split(/\s{2,}/).filter(s => s.trim().length > 0);
  if (sentences.length > 1) {
    result = sentences.map(sentence => `<p>${sentence.trim()}</p>`).join('\n');
  } else if (result.trim()) {
    result = `<p>${result.trim()}</p>`;
  }
  
  // Step 8: Fix any malformed tags (cleanup broken strong/em tags)
  result = result
    .replace(/<\/strong>\s*<\/strong>/gi, '</strong>') // Remove double closing tags
    .replace(/<strong>\s*<strong>/gi, '<strong>') // Remove double opening tags
    .replace(/<\/em>\s*<\/em>/gi, '</em>')
    .replace(/<em>\s*<em>/gi, '<em>')
    .replace(/<p>\s*<\/p>/gi, '') // Remove empty paragraphs
    .replace(/\n+/g, '\n') // Clean up line breaks
    .trim();
  
  console.log(`Formatted HTML output sample: ${result.substring(0, 200)}...`);
  return result;
}

// Strip Project Gutenberg boilerplate sections
function stripProjectGutenbergBoilerplate(html: string): string {
  // Remove PG header/footer blocks
  return html
    .replace(/\*\*\*\s*START\s+OF\s+THE?\s+PROJECT\s+GUTENBERG[\s\S]*?\*\*\*\s*END[\s\S]*?\*\*\*/gi, '')
    .replace(/Produced by[^.]*\./gi, '')
    .replace(/Project Gutenberg[^.]*\./gi, '');
}

// Slice HTML content by navigation anchors to get true chapter sections
function sliceSection(html: string, anchor: string, nextAnchors: string[] = []): string {
  console.log(`Slicing section from anchor: ${anchor}, until next: ${nextAnchors.join(', ')}`);
  
  try {
    if (!nodeHtmlParser) {
      console.warn(`node-html-parser not available, returning full content`);
      return html;
    }
    
    // Parse HTML with node-html-parser (server-friendly, no DOM)
    const root = nodeHtmlParser(html, { 
      lowerCaseTagName: false, 
      script: false, 
      style: false,
      blockTextElements: {
        script: true,
        noscript: true,
        style: true,
        pre: true
      }
    });
    
    // Find the start anchor element
    const startElement = root.querySelector(`#${anchor}`);
    if (!startElement) {
      console.warn(`Anchor #${anchor} not found, returning full content`);
      return html;
    }
    
    // Collect content from start element until we hit a next anchor
    const slice: string[] = [];
    let currentNode: any = startElement;
    
    // Start with the anchor element itself
    slice.push(currentNode.outerHTML || currentNode.toString());
    
    // Walk through siblings until we find a next anchor or reach the end
    while (currentNode.nextSibling) {
      currentNode = currentNode.nextSibling;
      
      // Check if this node or any of its children contains a next anchor
      const nodeId = currentNode.getAttribute?.('id');
      if (nodeId && nextAnchors.includes(nodeId)) {
        break; // Stop here, we've reached the next section
      }
      
      // Check for anchor IDs in child elements
      let foundNextAnchor = false;
      if (currentNode.querySelectorAll) {
        for (const nextAnchor of nextAnchors) {
          if (currentNode.querySelector(`#${nextAnchor}`)) {
            foundNextAnchor = true;
            break;
          }
        }
      }
      
      if (foundNextAnchor) {
        break;
      }
      
      // Add this node to our slice
      slice.push(currentNode.outerHTML || currentNode.toString());
    }
    
    const slicedHtml = slice.join('');
    console.log(`Successfully sliced ${slice.length} elements, ${slicedHtml.length} chars`);
    return slicedHtml;
    
  } catch (error) {
    console.warn(`Section slicing failed: ${error.message}, returning full content`);
    return html;
  }
}

// Modern front-matter detection using EPUB structure + content analysis
function isFrontMatterPage(htmlContent: string, textContent: string, wordCount: number, manifestItem: any): boolean {
  const lowerText = textContent.toLowerCase().trim();
  const normalizedText = textContent.trim();
  
  // Rule 1: Very short pages are likely title/part dividers
  if (wordCount < 20) {
    console.log(`Flagging as front-matter: ${wordCount} words - "${normalizedText.substring(0, 50)}..."`);
    return true;
  }
  
  // Rule 2: Respect EPUB spine linear="no" attribute
  if (manifestItem?.linear === 'no') {
    console.log(`Flagging as front-matter: spine linear="no" - "${normalizedText.substring(0, 50)}..."`);
    return true;
  }
  
  // Rule 3: Enhanced front-matter patterns (author, title, copyright, etc.)
  const frontMatterPatterns = [
    // Author names (common classics)
    /^(albert\s+)?camus\s*$/i,
    /^(antoine\s+de\s+)?saint[- ]exupéry\s*$/i,
    /^gustave\s+flaubert\s*$/i,
    /^victor\s+hugo\s*$/i,
    /^émile\s+zola\s*$/i,
    /^marcel\s+proust\s*$/i,
    
    // Classic French titles
    /^l[''']étranger\s*$/i,
    /^(le\s+)?petit[- ]prince\s*$/i,
    /^madame\s+bovary\s*$/i,
    /^les\s+misérables\s*$/i,
    /^à\s+la\s+recherche\s+du\s+temps\s+perdu\s*$/i,
    
    // English titles
    /^the\s+stranger\s*$/i,
    /^the\s+little\s+prince\s*$/i,
    
    // Publication info
    /^\(\d{4}\)\s*$/i, // (1857)
    /^\d{4}\s*$/i, // 1857
    /^(publié|published)\s+en\s+\d{4}/i,
    
    // Part/section dividers
    /^(première|deuxième|troisième)\s+partie\s*$/i,
    /^part\s+(one|two|three|i+)\s*$/i,
    /^partie\s+\d+\s*$/i,
    
    // Chapter headers without content
    /^chapitre\s+\d+\s*$/i,
    /^chapter\s+\d+\s*$/i,
    /^(prologue|épilogue|epilogue)\s*$/i,
    
    // Legal/publishing
    /^(copyright|©|\(c\))/i,
    /^(tous\s+droits\s+réservés|all\s+rights\s+reserved)/i,
    /^(éditions?|publisher?)/i,
    
    // Navigation/TOC
    /^(table\s+des?\s+matières?|contents?|sommaire)\s*$/i,
    /^(à\s+propos\s+de\s+cette\s+édition|about\s+this\s+edition)/i,
    
    // Dedication patterns
    /^à\s+[a-zàâäéèêëïîôöùûü\s\-]+$/i, // "À Marie-Antoine-Jules Senard"
    /^(cher\s+et\s+illustre\s+ami|dear\s+friend)/i,
    /^(membre\s+du\s+barreau|member\s+of\s+the\s+bar)/i,
    /^(permettez[- ]moi|allow\s+me)/i,
    
    // Standalone elements
    /^[ivxlc]+\s*$/i, // Roman numerals
    /^\d+\s*$/i, // Numbers only
    /^[a-z]\s*$/i, // Single letters
    
    // Common front-matter sections
    /^(dédicace?|dedication|avant[- ]propos|foreword|préface|preface)\s*$/i,
    /^(remerciements?|acknowledgments?)\s*$/i,
    /^(introduction|présentation)\s*$/i
  ];
  
  // Check if the entire text matches front-matter patterns
  if (frontMatterPatterns.some(pattern => pattern.test(normalizedText))) {
    console.log(`Flagging as front-matter: pattern match - "${normalizedText}"`);
    return true;
  }
  
  // Rule 4: Pages that are mostly just author/title repeated
  const keywordDensity = calculateKeywordDensity(lowerText, [
    'albert', 'camus', 'étranger', 'stranger', 'saint-exupéry', 'petit prince', 'little prince',
    'première partie', 'deuxième partie', 'part one', 'part two'
  ]);
  
  if (keywordDensity > 0.7) { // More than 70% title/author keywords
    console.log(`Flagging as front-matter: high keyword density (${(keywordDensity * 100).toFixed(1)}%) - "${normalizedText.substring(0, 50)}..."`);
    return true;
  }
  
  // Rule 5: Check for fixed-layout/image-heavy pages
  const imageRatio = (htmlContent.match(/<img/gi) || []).length / Math.max(wordCount, 1);
  if (imageRatio > 0.5 && wordCount < 50) {
    console.log(`Flagging as front-matter: image-heavy page (${imageRatio.toFixed(2)} img/word ratio)`);
    return true;
  }
  
  return false;
}

// Helper function to calculate keyword density
function calculateKeywordDensity(text: string, keywords: string[]): number {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return 0;
  
  const keywordMatches = keywords.reduce((count, keyword) => {
    const keywordWords = keyword.split(/\s+/);
    return count + (text.includes(keyword.toLowerCase()) ? keywordWords.length : 0);
  }, 0);
  
  return keywordMatches / words.length;
}

// Check if a TOC title indicates front-matter rather than actual content
function isFrontMatterTitle(title: string): boolean {
  const normalizedTitle = title.toLowerCase().trim();
  
  const frontMatterTitles = [
    // Common front-matter section titles
    'cover', 'title page', 'copyright', 'dedication', 'acknowledgments',
    'table of contents', 'contents', 'preface', 'foreword', 'introduction',
    'prologue', 'about the author', 'about this book',
    
    // French equivalents
    'couverture', 'page de titre', 'droits', 'dédicace', 'remerciements',
    'table des matières', 'sommaire', 'préface', 'avant-propos', 
    'prologue', 'à propos de l\'auteur',
    
    // Part dividers
    'part one', 'part two', 'part three', 'part i', 'part ii', 'part iii',
    'première partie', 'deuxième partie', 'troisième partie',
    'partie 1', 'partie 2', 'partie 3',
    
    // Empty or minimal titles
    '', 'untitled', 'sans titre'
  ];
  
  return frontMatterTitles.some(frontMatter => 
    normalizedTitle === frontMatter || 
    normalizedTitle.startsWith(frontMatter + ' ') ||
    normalizedTitle.endsWith(' ' + frontMatter)
  );
}

// Enhanced chapter title extraction with better French support
function extractChapterTitleEnhanced(htmlContent: string, textContent: string, manifestId: string): string {
  try {
    // Try XML parser first for proper HTML structure parsing
    if (xmlParser) {
      const parsed = xmlParser.parse(htmlContent);
      
      // Look for title in various HTML structures
      const candidates = [
        parsed.html?.head?.title?.['#text'],
        parsed.html?.body?.h1?.['#text'],
        parsed.html?.body?.h2?.['#text'],
        parsed.html?.body?.h3?.['#text'],
        parsed.h1?.['#text'],
        parsed.h2?.['#text'],
        parsed.h3?.['#text']
      ].filter(Boolean);
      
      if (candidates.length > 0) {
        return candidates[0].trim();
      }
    }
    
    // Fallback to regex-based extraction
    const titlePatterns = [
      /<title[^>]*>([^<]+)<\/title>/i,
      /<h1[^>]*>([^<]+)<\/h1>/i,
      /<h2[^>]*>([^<]+)<\/h2>/i,
      /<h3[^>]*>([^<]+)<\/h3>/i,
      /<p[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/p>/i
    ];
    
    for (const pattern of titlePatterns) {
      const match = htmlContent.match(pattern);
      if (match && match[1].trim()) {
        let title = match[1].trim();
        
        // Entity decoding is now handled by html-to-text library
        
        return title;
      }
    }
    
    // Try to extract from the first significant text content
    const firstSentence = textContent.split('.')[0].trim();
    if (firstSentence.length > 5 && firstSentence.length < 100) {
      return firstSentence;
    }
    
    return manifestId.replace(/^(id|chapter|ch|chap)/i, 'Chapter ');
  } catch (error) {
    console.warn(`Title extraction failed: ${error.message}`);
    return manifestId || 'Unknown Chapter';
  }
}

// Helper function to sanitize filename for storage
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9\-_.]/g, '_') // Replace special chars with underscore
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .replace(" ", '') // Remove leading/trailing underscores
    .toLowerCase();
}

// Helper function to count words
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

// Enhanced EPUB Parsing with performance optimizations
async function parseEpubContent(epubData: Uint8Array, filename: string): Promise<EpubContent> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const startTime = performance.now();
  
  console.log(`Starting enhanced EPUB parsing for: ${filename}`);
  
  try {
    // Extract ZIP files using fflate (4-8x faster than JSZip)
    const files = extractZipFiles(epubData);
    console.log(`EPUB extracted successfully, contains ${Object.keys(files).length} files`);
    
    // Find container.xml
    const containerFile = files['META-INF/container.xml'];
    if (!containerFile) {
      throw new Error('Invalid EPUB: META-INF/container.xml not found');
    }
    
    // Parse container.xml to find package document using fast-xml-parser
    const containerXml = new TextDecoder().decode(containerFile);
    const packagePath = extractPackagePathFast(containerXml);
    console.log(`Found package document at: ${packagePath}`);
    
    // Load and parse package document
    const packageFile = files[packagePath];
    if (!packageFile) {
      throw new Error(`Package document not found at: ${packagePath}`);
    }
    
    const packageXml = new TextDecoder().decode(packageFile);
    const packageData = parsePackageDocumentFast(packageXml);
    console.log(`Parsed package document, found ${packageData.spine.length} spine items`);
    
    // Parse navigation document with EPUB 3 support + NCX fallback
    let tableOfContents: TocEntry[] = [];
    let tocMapping: Map<string, TocEntry> = new Map();
    
    try {
      // Try EPUB 3 navigation document first
      const navItem = packageData.manifest.find(item => 
        item.properties?.includes('nav') || 
        (item.mediaType === 'application/xhtml+xml' && item.href.includes('nav'))
      );
      
      if (navItem) {
        const navPath = resolveHref(packagePath, navItem.href);
        const navFile = files[navPath];
        if (navFile) {
          const navContent = new TextDecoder().decode(navFile);
          tableOfContents = parseNavigationDocumentFast(navContent);
          console.log(`✅ Parsed EPUB 3 navigation document, found ${tableOfContents.length} TOC entries`);
        }
      }
      
      // Fallback to NCX file (EPUB 2 standard)
      if (tableOfContents.length === 0) {
        const ncxItem = packageData.manifest.find(item => 
          item.mediaType === 'application/x-dtbncx+xml' || item.href.includes('.ncx')
        );
        
        if (ncxItem) {
          const ncxPath = resolveHref(packagePath, ncxItem.href);
          const ncxFile = files[ncxPath];
          if (ncxFile) {
            const ncxContent = new TextDecoder().decode(ncxFile);
            tableOfContents = parseNCXDocument(ncxContent);
            console.log(`✅ Parsed NCX navigation, found ${tableOfContents.length} TOC entries`);
          }
        }
      }
      
      // Create href-to-TOC mapping for chapter organization
      const buildTocMapping = (entries: TocEntry[]) => {
        entries.forEach(entry => {
          const cleanHref = entry.href.split('#')[0]; // Remove fragment identifiers
          tocMapping.set(cleanHref, entry);
          if (entry.children) {
            buildTocMapping(entry.children);
          }
        });
      };
      
      buildTocMapping(tableOfContents);
      console.log(`Built TOC mapping with ${tocMapping.size} href entries`);
      
    } catch (error) {
      warnings.push(`Failed to parse navigation: ${error.message}`);
      console.warn(`Navigation parsing warning: ${error.message}`);
    }
    
    // Process chapters using navigation anchors for proper chapter splitting
    const chapters: Chapter[] = [];
    let totalWordCount = 0;
    let chapterNumber = 1;
    
    // First, try to process chapters by TOC navigation anchors
    if (tableOfContents.length > 0) {
      console.log(`🔄 Processing chapters by navigation anchors (${tableOfContents.length} TOC entries)`);
      
      // Build list of all anchors in reading order
      const allAnchors: { anchor: string, title: string, href: string, level: number }[] = [];
      const collectAnchors = (entries: TocEntry[]) => {
        entries.forEach(entry => {
          if (entry.href.includes('#')) {
            const [file, anchor] = entry.href.split('#');
            if (anchor) {
              allAnchors.push({
                anchor: anchor,
                title: entry.title,
                href: entry.href,
                level: entry.level
              });
            }
          }
          if (entry.children) {
            collectAnchors(entry.children);
          }
        });
      };
      collectAnchors(tableOfContents);
      
      // Group anchors by file
      const anchorsByFile = new Map<string, typeof allAnchors>();
      allAnchors.forEach(anchorInfo => {
        const [file] = anchorInfo.href.split('#');
        if (!anchorsByFile.has(file)) {
          anchorsByFile.set(file, []);
        }
        anchorsByFile.get(file)!.push(anchorInfo);
      });
      
      // Process each file's anchors
      for (const [fileName, anchors] of anchorsByFile) {
        try {
          // Find the spine file
          const manifestItem = packageData.manifest.find(item => item.href === fileName);
          if (!manifestItem) continue;
          
          const filePath = resolveHref(packagePath, fileName);
          const fileData = files[filePath];
          if (!fileData) continue;
          
          const fullHtmlContent = new TextDecoder().decode(fileData);
          
          // Process each anchor in this file
          for (let j = 0; j < anchors.length; j++) {
            const anchor = anchors[j];
            const nextAnchors = anchors.slice(j + 1).map(a => a.anchor);
            
            try {
                             // Slice the HTML content for this specific section
               const sectionHtml = sliceSection(fullHtmlContent, anchor.anchor, nextAnchors);
               const textContent = extractTextFromHtml(sectionHtml);
               const formattedContent = extractFormattedHtml(sectionHtml);
               const wordCount = countWords(textContent);
               
               // Skip front-matter sections
               if (isFrontMatterPage(sectionHtml, textContent, wordCount, manifestItem) || 
                   isFrontMatterTitle(anchor.title)) {
                 console.log(`Skipped anchor "${anchor.title}": front-matter section`);
                 continue;
               }
               
               // Only include substantial content sections
               if (wordCount < 50) {
                 console.log(`Skipped anchor "${anchor.title}": too short (${wordCount} words)`);
                 continue;
               }
               
               totalWordCount += wordCount;
               
               chapters.push({
                 id: `${manifestItem.id}_${anchor.anchor}`,
                 title: anchor.title,
                 href: anchor.href,
                 htmlContent: formattedContent, // Formatted HTML for frontend display
                 textContent: textContent, // Plain text for search/word count
                 wordCount: wordCount,
                 order: chapterNumber - 1,
                 level: anchor.level
               });
              
              console.log(`✅ Chapter ${chapterNumber}: "${anchor.title}" (${wordCount} words, level ${anchor.level})`);
              chapterNumber++;
              
            } catch (error) {
              console.warn(`Failed to process anchor ${anchor.anchor}: ${error.message}`);
            }
          }
        } catch (error) {
          console.warn(`Failed to process file ${fileName}: ${error.message}`);
        }
      }
    }
    
    // Fallback: process spine items as whole chapters if no navigation anchors found
    if (chapters.length === 0) {
      console.log(`⚠️ No navigation anchors found, falling back to spine-based processing`);
      
      for (let i = 0; i < packageData.spine.length; i++) {
        const spineItem = packageData.spine[i];
        try {
          const manifestItem = packageData.manifest.find(item => item.id === spineItem.idref);
          if (!manifestItem) {
            warnings.push(`Spine item ${spineItem.idref} not found in manifest`);
            continue;
          }
          
          const chapterPath = resolveHref(packagePath, manifestItem.href);
          const chapterFile = files[chapterPath];
          
          if (!chapterFile) {
            warnings.push(`Chapter file not found: ${chapterPath}`);
            continue;
          }
          
          const htmlContent = new TextDecoder().decode(chapterFile);
          const textContent = extractTextFromHtml(htmlContent);
          const formattedContent = extractFormattedHtml(htmlContent);
          const wordCount = countWords(textContent);
          
          // Skip front-matter pages using modern EPUB structure analysis
          if (isFrontMatterPage(htmlContent, textContent, wordCount, manifestItem)) {
            console.log(`Skipped spine item ${i + 1}: front-matter page`);
            continue;
          }
          
          totalWordCount += wordCount;
          
          // Extract chapter title using TOC mapping first, then fallback methods
          const cleanHref = manifestItem.href.split('#')[0];
          const tocEntry = tocMapping.get(cleanHref);
          let title: string;
          
          if (tocEntry && tocEntry.title && !isFrontMatterTitle(tocEntry.title)) {
            title = tocEntry.title;
            console.log(`Using TOC title: "${title}"`);
          } else {
            title = extractChapterTitleEnhanced(htmlContent, textContent, manifestItem.id);
            console.log(`Using extracted title: "${title}"`);
          }
          
          const level = tocEntry?.level || 1;
          
          chapters.push({
            id: manifestItem.id,
            title: title,
            href: manifestItem.href,
            htmlContent: formattedContent, // Formatted HTML for frontend display
            textContent: textContent, // Plain text for search/word count
            wordCount: wordCount,
            order: chapterNumber - 1,
            level: level
          });
          
          console.log(`✅ Fallback Chapter ${chapterNumber}: "${title}" (${wordCount} words, level ${level})`);
          chapterNumber++;
        } catch (error) {
          warnings.push(`Failed to process spine chapter ${i}: ${error.message}`);
          console.warn(`Spine chapter processing warning: ${error.message}`);
        }
      }
    }
    
    // Process resources (images, stylesheets, fonts) with enhanced performance
    const resources = await processEpubResourcesFast(files, packageData.manifest, packagePath);
    
    // Calculate reading time estimate (average 200 words per minute)
    const estimatedReadingTime = Math.ceil(totalWordCount / 200);
    
    const epubContent: EpubContent = {
      metadata: {
        title: packageData.metadata.title || 'Unknown Title',
        author: packageData.metadata.creator || 'Unknown Author',
        language: packageData.metadata.language || 'en',
        identifier: packageData.metadata.identifier || '',
        publisher: packageData.metadata.publisher,
        publishedDate: packageData.metadata.date,
        description: packageData.metadata.description,
        subject: packageData.metadata.subject ? [packageData.metadata.subject] : [],
        rights: packageData.metadata.rights,
        source: packageData.metadata.source
      },
      structure: {
        totalChapters: chapters.length,
        estimatedReadingTime: estimatedReadingTime,
        wordCount: totalWordCount,
        tableOfContents: tableOfContents,
        spine: packageData.spine.map(item => ({
          id: item.idref,
          href: packageData.manifest.find(m => m.id === item.idref)?.href || '',
          mediaType: packageData.manifest.find(m => m.id === item.idref)?.mediaType || 'application/xhtml+xml',
          linear: item.linear !== 'no',
          properties: packageData.manifest.find(m => m.id === item.idref)?.properties
        }))
      },
      chapters: chapters,
      resources: resources,
      parsing: {
        parsedAt: new Date().toISOString(),
        epubVersion: packageData.version || '3.0',
        parser: 'supabase-epub-parser-v2.0-optimized',
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined
      }
    };
    
    const totalTime = performance.now() - startTime;
    console.log(`EPUB parsing completed successfully for ${filename} in ${totalTime.toFixed(2)}ms`);
    console.log(`- ${chapters.length} chapters processed`);
    console.log(`- ${totalWordCount} total words`);
    console.log(`- ${estimatedReadingTime} minutes estimated reading time`);
    console.log(`- ${warnings.length} warnings, ${errors.length} errors`);
    console.log(`- Performance: ${(totalWordCount / (totalTime / 1000)).toFixed(0)} words/sec`);
    
    return epubContent;
    
  } catch (error) {
    console.error(`EPUB parsing failed for ${filename}:`, error);
    throw new Error(`EPUB parsing failed: ${error.message}`);
  }
}

// Enhanced XML parsing functions using fast-xml-parser
function extractPackagePathFast(containerXml: string): string {
  try {
    if (!xmlParser) {
      throw new Error('fast-xml-parser not available, falling back to regex');
    }
    const parsed = xmlParser.parse(containerXml);
    const rootfiles = parsed.container?.rootfiles?.rootfile;
    
    if (Array.isArray(rootfiles)) {
      return rootfiles[0]['@_full-path'];
    } else if (rootfiles) {
      return rootfiles['@_full-path'];
    }
    
    throw new Error('Package path not found in container.xml');
  } catch (error) {
    // Fallback to regex if XML parsing fails
    const match = containerXml.match(/full-path=["']([^"']+)["']/);
    if (!match) {
      throw new Error('Package path not found in container.xml');
    }
    return match[1];
  }
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string[];
}

interface RawSpineItem {
  idref: string;
  linear?: string;
}

function parsePackageDocumentFast(packageXml: string) {
  try {
    console.log('Parsing package document with fast-xml-parser');
    if (!xmlParser) {
      throw new Error('fast-xml-parser not available, falling back to regex');
    }
    const parsed = xmlParser.parse(packageXml);
    const pkg = parsed.package;
    
    // Extract metadata with enhanced namespace handling
    const metadata = pkg.metadata || {};
    const extractMetadataValue = (field: any) => {
      if (typeof field === 'string') return field;
      if (Array.isArray(field)) return field[0]?.['#text'] || field[0];
      return field?.['#text'] || field || undefined;
    };
    
    const processedMetadata = {
      title: extractMetadataValue(metadata['dc:title'] || metadata.title),
      creator: extractMetadataValue(metadata['dc:creator'] || metadata.creator),
      language: extractMetadataValue(metadata['dc:language'] || metadata.language),
      identifier: extractMetadataValue(metadata['dc:identifier'] || metadata.identifier),
      publisher: extractMetadataValue(metadata['dc:publisher'] || metadata.publisher),
      date: extractMetadataValue(metadata['dc:date'] || metadata.date),
      description: extractMetadataValue(metadata['dc:description'] || metadata.description),
      subject: extractMetadataValue(metadata['dc:subject'] || metadata.subject),
      rights: extractMetadataValue(metadata['dc:rights'] || metadata.rights),
      source: extractMetadataValue(metadata['dc:source'] || metadata.source)
    };
    
    // Extract version
    const version = pkg['@_version'] || '3.0';
    
    // Parse manifest items with enhanced attribute handling
    const manifest: ManifestItem[] = [];
    const manifestItems = pkg.manifest?.item || [];
    const itemsArray = Array.isArray(manifestItems) ? manifestItems : [manifestItems];
    
    for (const item of itemsArray) {
      if (item['@_id'] && item['@_href'] && item['@_media-type']) {
        manifest.push({
          id: item['@_id'],
          href: item['@_href'],
          mediaType: item['@_media-type'],
          properties: item['@_properties']?.split(' ')
        });
      }
    }
    
    // Parse spine items
    const spine: RawSpineItem[] = [];
    const spineItems = pkg.spine?.itemref || [];
    const spineArray = Array.isArray(spineItems) ? spineItems : [spineItems];
    
    for (const itemref of spineArray) {
      if (itemref['@_idref']) {
        spine.push({
          idref: itemref['@_idref'],
          linear: itemref['@_linear']
        });
      }
    }
    
    console.log(`fast-xml-parser extracted: ${manifest.length} manifest items, ${spine.length} spine items`);
    return { metadata: processedMetadata, manifest, spine, version };
    
  } catch (error) {
    console.warn(`fast-xml-parser failed, falling back to regex: ${error.message}`);
    
    // Fallback to regex-based parsing
    return parsePackageDocumentRegex(packageXml);
  }
}

// Fallback regex-based parsing (original method)
function parsePackageDocumentRegex(packageXml: string) {
  const metadata = {
    title: extractXmlValue(packageXml, 'dc:title') || extractXmlValue(packageXml, 'title'),
    creator: extractXmlValue(packageXml, 'dc:creator') || extractXmlValue(packageXml, 'creator'),
    language: extractXmlValue(packageXml, 'dc:language') || extractXmlValue(packageXml, 'language'),
    identifier: extractXmlValue(packageXml, 'dc:identifier') || extractXmlValue(packageXml, 'identifier'),
    publisher: extractXmlValue(packageXml, 'dc:publisher') || extractXmlValue(packageXml, 'publisher'),
    date: extractXmlValue(packageXml, 'dc:date') || extractXmlValue(packageXml, 'date'),
    description: extractXmlValue(packageXml, 'dc:description') || extractXmlValue(packageXml, 'description'),
    subject: extractXmlValue(packageXml, 'dc:subject') || extractXmlValue(packageXml, 'subject'),
    rights: extractXmlValue(packageXml, 'dc:rights') || extractXmlValue(packageXml, 'rights'),
    source: extractXmlValue(packageXml, 'dc:source') || extractXmlValue(packageXml, 'source')
  };
  
  const versionMatch = packageXml.match(/version=["']([^"']+)["']/);
  const version = versionMatch ? versionMatch[1] : '3.0';
  
  const manifestSection = packageXml.match(/<manifest[^>]*>(.*?)<\/manifest>/s);
  const manifest: ManifestItem[] = [];
  if (manifestSection) {
    const itemMatches = manifestSection[1].match(/<item[^>]*>/g) || [];
    for (const itemMatch of itemMatches) {
      const id = extractAttribute(itemMatch, 'id');
      const href = extractAttribute(itemMatch, 'href');
      const mediaType = extractAttribute(itemMatch, 'media-type');
      const properties = extractAttribute(itemMatch, 'properties')?.split(' ');
      
      if (id && href && mediaType) {
        manifest.push({ id, href, mediaType, properties });
      }
    }
  }
  
  const spineSection = packageXml.match(/<spine[^>]*>(.*?)<\/spine>/s);
  const spine: RawSpineItem[] = [];
  if (spineSection) {
    const itemrefMatches = spineSection[1].match(/<itemref[^>]*>/g) || [];
    for (const itemrefMatch of itemrefMatches) {
      const idref = extractAttribute(itemrefMatch, 'idref');
      const linear = extractAttribute(itemrefMatch, 'linear');
      
      if (idref) {
        spine.push({ idref, linear });
      }
    }
  }
  
  return { metadata, manifest, spine, version };
}

function extractXmlValue(xml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]*)<\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : undefined;
}

function extractAttribute(element: string, attrName: string): string | undefined {
  const regex = new RegExp(`${attrName}=["']([^"']+)["']`, 'i');
  const match = element.match(regex);
  return match ? match[1] : undefined;
}

function parseNavigationDocumentFast(navContent: string): TocEntry[] {
  try {
    console.log('Parsing navigation document with fast-xml-parser');
    if (!xmlParser) {
      throw new Error('fast-xml-parser not available, falling back to regex');
    }
    const parsed = xmlParser.parse(navContent);
    
    // Look for nav element with epub:type="toc"
    const navElements = Array.isArray(parsed.html?.body?.nav) ? parsed.html.body.nav : [parsed.html?.body?.nav].filter(Boolean);
    
    for (const nav of navElements) {
      if (nav['@_epub:type'] === 'toc' || nav['@_type'] === 'toc') {
        const ol = nav.ol;
        if (ol) {
          return extractTocFromList(ol, 0);
        }
      }
    }
    
    return [];
  } catch (error) {
    console.warn(`fast-xml-parser navigation failed, falling back to regex: ${error.message}`);
    return parseNavigationDocumentRegex(navContent);
  }
}

function extractTocFromList(listElement: any, level: number): TocEntry[] {
  const toc: TocEntry[] = [];
  const items = Array.isArray(listElement.li) ? listElement.li : [listElement.li].filter(Boolean);
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const link = item.a;
    
    if (link && link['@_href'] && link['#text']) {
      const entry: TocEntry = {
        id: `toc-${level}-${i}`,
        title: link['#text'].trim(),
        href: link['@_href'],
        level: level + 1,
        playOrder: i
      };
      
      // Handle nested lists
      if (item.ol) {
        entry.children = extractTocFromList(item.ol, level + 1);
      }
      
      toc.push(entry);
    }
  }
  
  return toc;
}

// Fallback regex-based navigation parsing
function parseNavigationDocumentRegex(navContent: string): TocEntry[] {
  const toc: TocEntry[] = [];
  
  const tocMatch = navContent.match(/<nav[^>]*epub:type=["']toc["'][^>]*>(.*?)<\/nav>/s);
  if (!tocMatch) return toc;
  
  const tocContent = tocMatch[1];
  const listMatch = tocContent.match(/<ol[^>]*>(.*?)<\/ol>/s);
  if (!listMatch) return toc;
  
  const listItems = listMatch[1].match(/<li[^>]*>.*?<\/li>/gs) || [];
  
  for (let i = 0; i < listItems.length; i++) {
    const item = listItems[i];
    const linkMatch = item.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/);
    
    if (linkMatch) {
      toc.push({
        id: `toc-${i}`,
        title: linkMatch[2].trim(),
        href: linkMatch[1],
        level: 1,
        playOrder: i
      });
    }
  }
  
  return toc;
}

// Parse EPUB 2 NCX navigation files
function parseNCXDocument(ncxContent: string): TocEntry[] {
  const toc: TocEntry[] = [];
  
  try {
    console.log('Parsing NCX document with fast-xml-parser');
    if (!xmlParser) {
      throw new Error('fast-xml-parser not available, falling back to regex');
    }
    
    const parsed = xmlParser.parse(ncxContent);
    const navMap = parsed.ncx?.navMap;
    
    if (navMap?.navPoint) {
      const navPoints = Array.isArray(navMap.navPoint) ? navMap.navPoint : [navMap.navPoint];
      
      const processNavPoint = (navPoint: any, level: number = 1): TocEntry => {
        const id = navPoint['@_id'] || `ncx-${level}-${Math.random().toString(36).substr(2, 9)}`;
        const playOrder = parseInt(navPoint['@_playOrder']) || 0;
        
        // Extract text and href
        const navLabel = navPoint.navLabel;
        const title = navLabel?.text?.['#text'] || navLabel?.text || navPoint['@_id'] || 'Untitled';
        
        const content = navPoint.content;
        const href = content?.['@_src'] || '';
        
        const entry: TocEntry = {
          id,
          title: title.trim(),
          href,
          level,
          playOrder
        };
        
        // Handle nested navigation points
        if (navPoint.navPoint) {
          const childNavPoints = Array.isArray(navPoint.navPoint) ? navPoint.navPoint : [navPoint.navPoint];
          entry.children = childNavPoints.map((child: any) => processNavPoint(child, level + 1));
        }
        
        return entry;
      };
      
      toc.push(...navPoints.map((navPoint: any) => processNavPoint(navPoint)));
    }
    
    console.log(`NCX parsing completed: ${toc.length} top-level entries`);
    return toc;
    
  } catch (error) {
    console.warn(`NCX fast-xml-parser failed, falling back to regex: ${error.message}`);
    
    // Fallback regex parsing for NCX
    const navPointMatches = ncxContent.match(/<navPoint[^>]*>.*?<\/navPoint>/gs) || [];
    
    for (let i = 0; i < navPointMatches.length; i++) {
      const navPoint = navPointMatches[i];
      
      // Extract title
      const textMatch = navPoint.match(/<text[^>]*>([^<]*)<\/text>/);
      const title = textMatch ? textMatch[1].trim() : `Chapter ${i + 1}`;
      
      // Extract href
      const contentMatch = navPoint.match(/<content[^>]*src=["']([^"']+)["']/);
      const href = contentMatch ? contentMatch[1] : '';
      
      if (href) {
        toc.push({
          id: `ncx-${i}`,
          title,
          href,
          level: 1,
          playOrder: i
        });
      }
    }
    
    return toc;
  }
}

function resolveHref(basePath: string, href: string): string {
  const baseDir = basePath.substring(0, basePath.lastIndexOf('/'));
  if (href.startsWith('/')) {
    return href.substring(1);
  }
  return baseDir ? `${baseDir}/${href}` : href;
}

async function processEpubResourcesFast(files: ZipFiles, manifest: any[], packagePath: string) {
  const resources = {
    coverImage: undefined as string | undefined,
    images: [] as ImageResource[],
    stylesheets: [] as string[],
    fonts: [] as FontResource[]
  };
  
  console.log('Processing EPUB resources with enhanced performance');
  const startTime = performance.now();
  
  for (const item of manifest) {
    try {
      if (item.mediaType.startsWith('image/')) {
        const imagePath = resolveHref(packagePath, item.href);
        const imageFile = files[imagePath];
        
        if (imageFile) {
          // Convert to base64 more efficiently
          const base64Data = btoa(String.fromCharCode(...imageFile));
          const imageSize = imageFile.length;
          
          const imageResource: ImageResource = {
            id: item.id,
            href: item.href,
            mediaType: item.mediaType
          };
          
          // Only embed small images (< 100KB)
          if (imageSize < 100000) {
            imageResource.base64 = `data:${item.mediaType};base64,${base64Data}`;
          }
          
          resources.images.push(imageResource);
          
          // Check if this might be a cover image
          if (item.properties?.includes('cover-image') || 
              item.href.toLowerCase().includes('cover') ||
              item.id.toLowerCase().includes('cover')) {
            resources.coverImage = imageResource.base64;
          }
        }
      } else if (item.mediaType === 'text/css') {
        const cssPath = resolveHref(packagePath, item.href);
        const cssFile = files[cssPath];
        
        if (cssFile) {
          const cssContent = new TextDecoder().decode(cssFile);
          resources.stylesheets.push(cssContent);
        }
      } else if (item.mediaType.includes('font') || item.href.toLowerCase().includes('.ttf') || 
                 item.href.toLowerCase().includes('.otf') || item.href.toLowerCase().includes('.woff')) {
        resources.fonts.push({
          id: item.id,
          href: item.href,
          mediaType: item.mediaType,
          fontFamily: item.id,
          isObfuscated: false
        });
      }
    } catch (error) {
      console.warn(`Failed to process resource ${item.href}: ${error.message}`);
    }
  }
  
  const processTime = performance.now() - startTime;
  console.log(`Resources processed in ${processTime.toFixed(2)}ms`);
  console.log(`- ${resources.images.length} images`);
  console.log(`- ${resources.stylesheets.length} stylesheets`);
  console.log(`- ${resources.fonts.length} fonts`);
  
  return resources;
}

console.log("🚀 Server-Friendly EPUB Parser v3.0 with True Chapter Splitting:")
console.log("  ✅ fflate - 4-8x faster ZIP extraction")
console.log("  ✅ fast-xml-parser - Streaming XML with namespace support") 
console.log("  ✅ html-to-text - Clean prose extraction (no DOM dependencies)")
console.log("  ✅ node-html-parser - Server-friendly HTML parsing")
console.log("  ✅ Navigation anchor slicing - True chapter boundaries")
console.log("  ✅ Project Gutenberg boilerplate removal")
console.log("  ✅ EPUB 3 navigation + NCX fallback")
console.log("  ✅ Smart front-matter detection")

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    })
  }

  try {
    // Get Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Parse form data
    const formData = await req.formData()
    
    const foreignFile = formData.get('foreignFile') as File
    const nativeFile = formData.get('nativeFile') as File
    const foreignTitle = formData.get('foreignTitle') as string
    const foreignAuthor = formData.get('foreignAuthor') as string
    const foreignLanguage = formData.get('foreignLanguage') as string
    const nativeTitle = formData.get('nativeTitle') as string
    const nativeAuthor = formData.get('nativeAuthor') as string
    const nativeLanguage = formData.get('nativeLanguage') as string
    const visibility = formData.get('visibility') as string
    const ownerId = formData.get('ownerId') as string

    // Validate required fields
    if (!foreignFile || !nativeFile || !ownerId) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: foreignFile, nativeFile, ownerId' }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      )
    }

    console.log(`Processing files: ${foreignFile.name} (${foreignFile.size} bytes), ${nativeFile.name} (${nativeFile.size} bytes)`)

    // Helper function to process uploaded file (ZIP or direct EPUB)
    const processUploadedFile = async (file: File, expectedSide: 'foreign' | 'native'): Promise<ProcessedFile> => {
      const arrayBuffer = await file.arrayBuffer()
      const uint8Array = new Uint8Array(arrayBuffer)
      
      // Check if it's a ZIP file
      if (file.name.endsWith('.zip') || file.type === 'application/zip') {
        console.log(`Decompressing ZIP file: ${file.name}`)
        
        try {
          if (!fflate?.unzipSync) {
            throw new Error('fflate not available, falling back to basic ZIP handling');
          }
          const zip = fflate.unzipSync(uint8Array)
          
          // Find EPUB files in the ZIP
          const epubFiles = Object.keys(zip).filter(filename => 
            filename.endsWith('.epub') && !zip[filename].dir
          )
          
          if (epubFiles.length === 0) {
            throw new Error(`No EPUB files found in ${file.name}`)
          }
          
          if (epubFiles.length > 1) {
            console.warn(`Multiple EPUB files found in ${file.name}, using first one: ${epubFiles[0]}`)
          }
          
          const epubFilename = epubFiles[0]
          const epubFile = zip[epubFilename]
          const epubData = epubFile as Uint8Array
          
          console.log(`Extracted ${epubFilename} from ZIP: ${epubData.length} bytes (was ${file.size} bytes compressed)`)
          
          return {
            data: epubData,
            filename: epubFilename,
            originalSize: epubData.length,
            compressedSize: file.size
          }
        } catch (error) {
          throw new Error(`Failed to decompress ZIP file ${file.name}: ${error.message}`)
        }
      } else if (file.name.endsWith('.epub')) {
        // Direct EPUB file
        return {
          data: uint8Array,
          filename: file.name,
          originalSize: file.size,
          compressedSize: file.size
        }
      } else {
        throw new Error(`Unsupported file type: ${file.name}. Only EPUB and ZIP files are supported.`)
      }
    }

    // Helper function to ensure storage bucket exists with proper configuration
    const ensureBucketExists = async (bucketName: string, isPublic: boolean) => {
      console.log(`Ensuring bucket exists: ${bucketName} (public: ${isPublic})`)
      
      // Try to create bucket
      const { data: bucketData, error: bucketError } = await supabase.storage.createBucket(bucketName, {
        public: isPublic,
        allowedMimeTypes: ['application/epub+zip', 'application/zip'],
        fileSizeLimit: 52428800, // 50MB in bytes
      })
      
      if (bucketError) {
        if (bucketError.message.includes('already exists')) {
          console.log(`Bucket ${bucketName} already exists`)
          
          // Update bucket settings if it exists but might have wrong config
          const { error: updateError } = await supabase.storage.updateBucket(bucketName, {
            public: isPublic,
            allowedMimeTypes: ['application/epub+zip', 'application/zip'],
            fileSizeLimit: 52428800,
          })
          
          if (updateError) {
            console.warn(`Could not update bucket settings: ${updateError.message}`)
          }
        } else {
          throw new Error(`Failed to create bucket ${bucketName}: ${bucketError.message}`)
        }
      } else {
        console.log(`Created new bucket: ${bucketName}`)
      }
    }

    // Helper function to upload file to storage
    const uploadFileToStorage = async (fileData: Uint8Array, originalFilename: string, side: 'foreign' | 'native') => {
      const bucketName = visibility === 'public' ? 'public-books' : 'private-books'
      
      // Ensure bucket exists
      await ensureBucketExists(bucketName, visibility === 'public')

      // Sanitize filename and create storage path
      const sanitizedFilename = sanitizeFilename(originalFilename)
      const timestamp = Date.now()
      const storagePath = `${ownerId}/${side}_${timestamp}_${sanitizedFilename}`
      
      console.log(`Original filename: ${originalFilename}`)
      console.log(`Sanitized storage path: ${storagePath}`)

      // Create a Blob from the Uint8Array for upload
      const blob = new Blob([fileData], { type: 'application/epub+zip' })
      
      const { data, error } = await supabase.storage
        .from(bucketName)
        .upload(storagePath, blob, {
          cacheControl: '3600',
          upsert: false,
          metadata: {
            owner_id: ownerId,
            original_size: fileData.length.toString(),
            original_filename: originalFilename,
          }
        })

      if (error) {
        console.error(`Storage upload error:`, error)
        throw new Error(`File upload failed: ${error.message}`)
      }

      console.log(`Successfully uploaded to: ${data.path}`)
      return data.path
    }

    // Helper function to create book record with EPUB content
    const createBookRecord = async (metadata: BookMetadata, epubPath: string, epubContent?: EpubContent) => {
      console.log(`Creating ${metadata.side} book record:`)
      console.log(`  - Title: ${metadata.title}`)
      console.log(`  - Author: ${metadata.author}`)
      console.log(`  - Language: ${metadata.language}`)
      console.log(`  - EPUB Path: ${epubPath}`)
      console.log(`  - Parsed Content: ${epubContent ? 'YES - storing in json_blob' : 'NO - json_blob will be null'}`)
      if (epubContent) {
        console.log(`  - Cover Image: ${epubContent.resources.coverImage ? 'Found and stored in cover_url' : 'Not found'}`)
        console.log(`  - JSON Blob Size: ~${JSON.stringify(epubContent).length} characters`)
      }

      const bookData = {
        owner_id: ownerId,
        visibility: visibility as 'public' | 'private',
        language_code: metadata.language || 'en',
        side: metadata.side,
        title: metadata.title || metadata.originalFilename.replace('.epub', ''),
        author: metadata.author || '',
        epub_path: epubPath,
        published_on: null,
        cover_url: epubContent?.resources.coverImage || null,
        json_blob: epubContent || null, // Store parsed EPUB content in json_blob field
        is_deleted: false
      }

      const { data, error } = await supabase
        .from('books')
        .insert(bookData)
        .select()
        .single()

      if (error) {
        throw new Error(`Book creation failed: ${error.message}`)
      }

      return data
    }

    // Process uploaded files
    console.log('Processing foreign file...')
    const foreignProcessed = await processUploadedFile(foreignFile, 'foreign')
    
    console.log('Processing native file...')
    const nativeProcessed = await processUploadedFile(nativeFile, 'native')

    // Upload files to storage with sanitized names
    console.log('Uploading foreign book to storage...')
    const foreignEpubPath = await uploadFileToStorage(foreignProcessed.data, foreignProcessed.filename, 'foreign')
    
    console.log('Uploading native book to storage...')
    const nativeEpubPath = await uploadFileToStorage(nativeProcessed.data, nativeProcessed.filename, 'native')

    // Parse EPUB content immediately after storage upload
    console.log('=== Starting EPUB Content Parsing Phase ===')
    
    // Initialize parsing results with detailed tracking
    let foreignEpubContent: EpubContent | undefined
    let nativeEpubContent: EpubContent | undefined
    let foreignParsingError: string | undefined
    let nativeParsingError: string | undefined
    
    // Parse foreign EPUB with enhanced error tracking
    console.log(`Parsing foreign EPUB: ${foreignProcessed.filename}`)
    try {
      const startTime = Date.now()
      foreignEpubContent = await parseEpubContent(foreignProcessed.data, foreignProcessed.filename)
      const parseTime = Date.now() - startTime
      
      console.log(`✅ Foreign EPUB parsed successfully in ${parseTime}ms:`)
      console.log(`   - Title: ${foreignEpubContent.metadata.title}`)
      console.log(`   - Author: ${foreignEpubContent.metadata.author}`)
      console.log(`   - Chapters: ${foreignEpubContent.structure.totalChapters}`)
      console.log(`   - Words: ${foreignEpubContent.structure.wordCount}`)
      console.log(`   - Reading time: ${foreignEpubContent.structure.estimatedReadingTime} minutes`)
      console.log(`   - Cover found: ${!!foreignEpubContent.resources.coverImage}`)
    } catch (error) {
      foreignParsingError = error.message
      console.error(`❌ Foreign EPUB parsing failed: ${error.message}`)
      console.log(`   - Book record will still be created but without parsed content`)
      console.log(`   - File: ${foreignProcessed.filename} (${foreignProcessed.data.length} bytes)`)
    }
    
    // Parse native EPUB with enhanced error tracking
    console.log(`Parsing native EPUB: ${nativeProcessed.filename}`)
    try {
      const startTime = Date.now()
      nativeEpubContent = await parseEpubContent(nativeProcessed.data, nativeProcessed.filename)
      const parseTime = Date.now() - startTime
      
      console.log(`✅ Native EPUB parsed successfully in ${parseTime}ms:`)
      console.log(`   - Title: ${nativeEpubContent.metadata.title}`)
      console.log(`   - Author: ${nativeEpubContent.metadata.author}`)
      console.log(`   - Chapters: ${nativeEpubContent.structure.totalChapters}`)
      console.log(`   - Words: ${nativeEpubContent.structure.wordCount}`)
      console.log(`   - Reading time: ${nativeEpubContent.structure.estimatedReadingTime} minutes`)
      console.log(`   - Cover found: ${!!nativeEpubContent.resources.coverImage}`)
    } catch (error) {
      nativeParsingError = error.message
      console.error(`❌ Native EPUB parsing failed: ${error.message}`)
      console.log(`   - Book record will still be created but without parsed content`)
      console.log(`   - File: ${nativeProcessed.filename} (${nativeProcessed.data.length} bytes)`)
    }
    
    // Log parsing phase summary
    console.log('=== EPUB Parsing Phase Complete ===')
    console.log(`Foreign: ${foreignEpubContent ? 'SUCCESS' : 'FAILED'}`)
    console.log(`Native: ${nativeEpubContent ? 'SUCCESS' : 'FAILED'}`)
    if (foreignParsingError || nativeParsingError) {
      console.log('Parsing errors occurred but books will still be created with available metadata')
    }

    // Create book records with parsed content
    console.log('Creating foreign book record')
    const foreignBook = await createBookRecord({
      title: foreignTitle || foreignEpubContent?.metadata.title || 'Unknown Title',
      author: foreignAuthor || foreignEpubContent?.metadata.author || 'Unknown Author',
      language: foreignLanguage || foreignEpubContent?.metadata.language || 'en',
      originalFilename: foreignProcessed.filename,
      side: 'foreign'
    }, foreignEpubPath, foreignEpubContent)

    console.log('Creating native book record')
    const nativeBook = await createBookRecord({
      title: nativeTitle || nativeEpubContent?.metadata.title || 'Unknown Title',
      author: nativeAuthor || nativeEpubContent?.metadata.author || 'Unknown Author',
      language: nativeLanguage || nativeEpubContent?.metadata.language || 'en',
      originalFilename: nativeProcessed.filename,
      side: 'native'
    }, nativeEpubPath, nativeEpubContent)

    // Create book pair
    console.log('Creating book pair')
    const { data: bookPair, error: pairError } = await supabase
      .from('book_pairs')
      .insert({
        owner_id: ownerId,
        foreign_book_id: foreignBook.id,
        native_book_id: nativeBook.id,
        alignment: null
      })
      .select()
      .single()

    if (pairError) {
      // Clean up uploaded files and created books on failure
      const bucketName = visibility === 'public' ? 'public-books' : 'private-books'
      await supabase.storage.from(bucketName).remove([foreignEpubPath, nativeEpubPath])
      await supabase.from('books').delete().eq('id', foreignBook.id)
      await supabase.from('books').delete().eq('id', nativeBook.id)
      
      throw new Error(`Book pair creation failed: ${pairError.message}`)
    }

    console.log('Successfully created book pair:', bookPair.id)

    return new Response(
      JSON.stringify({ 
        success: true,
        bookPairId: bookPair.id,
        foreignBookId: foreignBook.id,
        nativeBookId: nativeBook.id,
        parsing: {
          foreignParsed: !!foreignEpubContent,
          nativeParsed: !!nativeEpubContent,
          foreignChapters: foreignEpubContent?.structure.totalChapters || 0,
          nativeChapters: nativeEpubContent?.structure.totalChapters || 0,
          foreignWords: foreignEpubContent?.structure.wordCount || 0,
          nativeWords: nativeEpubContent?.structure.wordCount || 0,
          foreignReadingTime: foreignEpubContent?.structure.estimatedReadingTime || 0,
          nativeReadingTime: nativeEpubContent?.structure.estimatedReadingTime || 0,
          foreignCoverFound: !!foreignEpubContent?.resources.coverImage,
          nativeCoverFound: !!nativeEpubContent?.resources.coverImage,
          foreignError: foreignParsingError || null,
          nativeError: nativeParsingError || null,
          bothSuccessful: !!foreignEpubContent && !!nativeEpubContent,
          summary: {
            totalBooks: 2,
            successfullyParsed: (foreignEpubContent ? 1 : 0) + (nativeEpubContent ? 1 : 0),
            failedToParse: (foreignEpubContent ? 0 : 1) + (nativeEpubContent ? 0 : 1),
            totalChapters: (foreignEpubContent?.structure.totalChapters || 0) + (nativeEpubContent?.structure.totalChapters || 0),
            totalWords: (foreignEpubContent?.structure.wordCount || 0) + (nativeEpubContent?.structure.wordCount || 0)
          }
        },
        compressionInfo: {
          foreignOriginalSize: foreignProcessed.originalSize,
          foreignCompressedSize: foreignProcessed.compressedSize,
          nativeOriginalSize: nativeProcessed.originalSize,
          nativeCompressedSize: nativeProcessed.compressedSize,
          compressionRatio: ((foreignProcessed.compressedSize + nativeProcessed.compressedSize) / 
                           (foreignProcessed.originalSize + nativeProcessed.originalSize) * 100).toFixed(1) + '%'
        },
        message: 'Books uploaded, parsed, and paired successfully!'
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    )

  } catch (error) {
    console.error('Error in add-new-book function:', error)
    return new Response(
      JSON.stringify({ 
        error: error.message || 'An unexpected error occurred',
        hint: error.message?.includes('decompress') ? 
          'Try uploading the EPUB files directly without compression, or ensure the ZIP file contains valid EPUB files.' :
          error.message?.includes('Invalid key') ?
          'Filename contains invalid characters. Please rename your file to use only letters, numbers, hyphens, and underscores.' :
          error.message?.includes('EPUB parsing failed') ?
          'The EPUB file could not be parsed. The book will be uploaded but content extraction failed. Check that the file is a valid EPUB.' :
          'Check file size limits and ensure files are valid EPUB format.'
      }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    )
  }
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request with ZIP or EPUB files:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/add-new-book' \
    --header 'Authorization: Bearer [YOUR_TOKEN]' \
    --header 'Content-Type: multipart/form-data' \
    --form 'foreignFile=@/path/to/foreign.epub' \
    --form 'nativeFile=@/path/to/native.epub' \
    --form 'foreignTitle=Le Petit Prince' \
    --form 'foreignAuthor=Antoine de Saint-Exupéry' \
    --form 'foreignLanguage=fr' \
    --form 'nativeTitle=The Little Prince' \
    --form 'nativeAuthor=Antoine de Saint-Exupéry' \
    --form 'nativeLanguage=en' \
    --form 'visibility=public' \
    --form 'ownerId=[USER_ID]'

  3. To test EPUB parsing flow:
     - Upload a valid EPUB file to verify complete parsing pipeline
     - Check response for parsing status and metadata
     - Verify json_blob field is populated in database
     - Test with invalid EPUB to ensure graceful error handling
     - Check that books are still created even if parsing fails

  4. Expected workflow:
     ✓ File upload and storage
     ✓ EPUB parsing (with detailed logging)
     ✓ Book record creation with json_blob
     ✓ Book pair creation
     ✓ Response with parsing statistics

*/
