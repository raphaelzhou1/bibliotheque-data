// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"

// Performance-optimized imports
// Using dynamic imports to handle potential module resolution issues
let fflate: any, XMLParser: any, DOMPurify: any, entities: any;

try {
  const fflateModule = await import("https://esm.sh/fflate@0.8.1");
  fflate = fflateModule;
  
  const xmlParserModule = await import("https://esm.sh/fast-xml-parser@4.3.4");
  XMLParser = xmlParserModule.XMLParser;
  
  const domPurifyModule = await import("https://esm.sh/dompurify@3.0.8");
  DOMPurify = domPurifyModule.default;
  
  const heModule = await import("https://esm.sh/he@1.2.0");
  entities = heModule;
} catch (error) {
  console.warn("Failed to load performance libraries, falling back to basic implementations");
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

// Modern HTML text extraction using DOMPurify + textContent + he entity decoding
function extractTextFromHtml(htmlContent: string): string {
  console.log(`Processing HTML content (${htmlContent.length} chars) with modern parser`);
  const startTime = performance.now();
  
  try {
    // Step 1: Sanitize HTML with DOMPurify to remove XSS and normalize structure
    let cleanHtml = htmlContent;
    if (DOMPurify?.sanitize) {
      cleanHtml = DOMPurify.sanitize(htmlContent, { 
        RETURN_DOM: false,
        ALLOWED_TAGS: [], // Strip all tags, keep only text content
        KEEP_CONTENT: true // Preserve text inside removed tags
      });
      console.log(`DOMPurify sanitization completed`);
    } else {
      // Basic fallback: remove dangerous content
      cleanHtml = htmlContent
        .replace(/<script[^>]*>.*?<\/script>/gis, '')
        .replace(/<style[^>]*>.*?<\/style>/gis, '')
        .replace(/<head[^>]*>.*?<\/head>/gis, '');
    }
    
    // Step 2: Use DOM parsing to extract clean text content
    let textContent = '';
    
    // Try using DOMParser for proper HTML parsing
    try {
      // Create a minimal DOM environment for text extraction
      const parser = new DOMParser();
      const doc = parser.parseFromString(cleanHtml, 'text/html');
      textContent = doc.documentElement.textContent || doc.body?.textContent || '';
      console.log(`DOM textContent extraction successful`);
    } catch (domError) {
      console.warn(`DOM parsing failed, using regex fallback: ${domError.message}`);
      // Fallback: regex-based tag removal
      textContent = cleanHtml
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    
    // Step 3: Decode HTML entities using 'he' library for accurate Unicode
    let finalText = textContent;
    if (entities?.decode) {
      finalText = entities.decode(textContent);
      console.log(`HTML entities decoded with 'he' library`);
    } else {
      // Enhanced fallback entity decoding
      finalText = textContent
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
        .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    
    // Step 4: Final cleanup and normalization
    finalText = finalText
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/\r\n|\r|\n/g, ' ') // Convert line breaks to spaces
      .trim();
    
    const processTime = performance.now() - startTime;
    console.log(`Modern HTML processing completed in ${processTime.toFixed(2)}ms`);
    console.log(`Output: ${finalText.length} chars clean text`);
    
    return finalText;
  } catch (error) {
    console.error(`Modern HTML processing failed: ${error.message}`);
    
    // Ultimate fallback to very basic processing
    return htmlContent
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
  
  // Rule 3: Common front-matter patterns (author, title, copyright, etc.)
  const frontMatterPatterns = [
    // Author name only
    /^(albert\s+)?camus\s*$/i,
    /^(antoine\s+de\s+)?saint[- ]exupéry\s*$/i,
    
    // Title pages
    /^l[''']étranger\s*$/i,
    /^(le\s+)?petit[- ]prince\s*$/i,
    /^the\s+stranger\s*$/i,
    /^the\s+little\s+prince\s*$/i,
    
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
    
    // TOC/Navigation
    /^(table\s+des?\s+matières?|contents?|sommaire)\s*$/i,
    
    // Standalone roman numerals or numbers (page markers)
    /^[ivxlc]+\s*$/i,
    /^\d+\s*$/,
    
    // Dedication/Foreword
    /^(dédicace?|dedication|avant[- ]propos|foreword|préface|preface)\s*$/i
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
        
        // Decode entities in the title
        if (entities?.decodeHTML) {
          title = entities.decodeHTML(title);
        }
        
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
    
    // Process chapters from spine with enhanced performance and content filtering
    const chapters: Chapter[] = [];
    let totalWordCount = 0;
    let chapterNumber = 1; // Track actual content chapters separately from spine index
    
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
        const wordCount = countWords(textContent);
        
        // Skip front-matter pages using modern EPUB structure analysis
        if (isFrontMatterPage(htmlContent, textContent, wordCount, manifestItem)) {
          console.log(`Skipped spine item ${i + 1}: front-matter page`);
          continue;
        }
        
        // Only count and include actual content chapters
        totalWordCount += wordCount;
        
        // Extract chapter title using TOC mapping first, then fallback methods
        const cleanHref = manifestItem.href.split('#')[0];
        const tocEntry = tocMapping.get(cleanHref);
        let title: string;
        
        if (tocEntry && tocEntry.title && !isFrontMatterTitle(tocEntry.title)) {
          // Use title from TOC if available and meaningful
          title = tocEntry.title;
          console.log(`Using TOC title: "${title}"`);
        } else {
          // Fallback to enhanced title extraction
          title = extractChapterTitleEnhanced(htmlContent, textContent, manifestItem.id);
          console.log(`Using extracted title: "${title}"`);
        }
        
        // Determine chapter level from TOC hierarchy
        const level = tocEntry?.level || 1;
        
        chapters.push({
          id: manifestItem.id,
          title: title,
          href: manifestItem.href,
          htmlContent: htmlContent,
          textContent: textContent,
          wordCount: wordCount,
          order: chapterNumber - 1, // 0-based for frontend
          level: level
        });
        
        console.log(`✅ Chapter ${chapterNumber}: "${title}" (${wordCount} words, level ${level})`);
        chapterNumber++;
      } catch (error) {
        warnings.push(`Failed to process chapter ${i}: ${error.message}`);
        console.warn(`Chapter processing warning: ${error.message}`);
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

console.log("🚀 Modern EPUB Parser v3.0 with Specialist Components:")
console.log("  ✅ fflate - 4-8x faster ZIP extraction")
console.log("  ✅ fast-xml-parser - Streaming XML with namespace support") 
console.log("  ✅ DOMPurify + textContent - Clean prose extraction")
console.log("  ✅ he - Complete HTML entity decoding")
console.log("  ✅ EPUB 3 navigation + NCX fallback")
console.log("  ✅ Smart front-matter detection")
console.log("  ✅ TOC-driven chapter organization")

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
