// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import JSZip from "jszip"

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

// Helper function to extract text content from HTML
function extractTextFromHtml(htmlContent: string): string {
  return htmlContent
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<style[^>]*>.*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper function to count words
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

// Helper functions for XML parsing
function extractPackagePath(containerXml: string): string {
  const match = containerXml.match(/full-path=["']([^"']+)["']/);
  if (!match) {
    throw new Error('Package path not found in container.xml');
  }
  return match[1];
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

function parsePackageDocument(packageXml: string) {
  // Extract metadata
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
  
  // Extract version
  const versionMatch = packageXml.match(/version=["']([^"']+)["']/);
  const version = versionMatch ? versionMatch[1] : '3.0';
  
  // Parse manifest items
  const manifestSection = packageXml.match(/<manifest[^>]*>(.*?)<\/manifest>/s);
  const manifest: any[] = [];
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
  
  // Parse spine items
  const spineSection = packageXml.match(/<spine[^>]*>(.*?)<\/spine>/s);
  const spine: any[] = [];
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

function parseNavigationDocument(navContent: string): TocEntry[] {
  const toc: TocEntry[] = [];
  
  // Look for nav element with epub:type="toc"
  const tocMatch = navContent.match(/<nav[^>]*epub:type=["']toc["'][^>]*>(.*?)<\/nav>/s);
  if (!tocMatch) return toc;
  
  const tocContent = tocMatch[1];
  const listMatch = tocContent.match(/<ol[^>]*>(.*?)<\/ol>/s);
  if (!listMatch) return toc;
  
  // Parse list items
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

function extractChapterTitle(htmlContent: string): string | undefined {
  const titlePatterns = [
    /<h1[^>]*>([^<]*)<\/h1>/i,
    /<h2[^>]*>([^<]*)<\/h2>/i,
    /<title[^>]*>([^<]*)<\/title>/i
  ];
  
  for (const pattern of titlePatterns) {
    const match = htmlContent.match(pattern);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  
  return undefined;
}

function resolveHref(basePath: string, href: string): string {
  const baseDir = basePath.substring(0, basePath.lastIndexOf('/'));
  if (href.startsWith('/')) {
    return href.substring(1);
  }
  return baseDir ? `${baseDir}/${href}` : href;
}

async function processEpubResources(zip: JSZip, manifest: any[], packagePath: string) {
  const resources = {
    coverImage: undefined as string | undefined,
    images: [] as ImageResource[],
    stylesheets: [] as string[],
    fonts: [] as FontResource[]
  };
  
  for (const item of manifest) {
    try {
      if (item.mediaType.startsWith('image/')) {
        const imagePath = resolveHref(packagePath, item.href);
        const imageFile = zip.files[imagePath];
        
        if (imageFile) {
          const imageData = await imageFile.async('base64');
          const imageSize = imageData.length * 0.75;
          
          const imageResource: ImageResource = {
            id: item.id,
            href: item.href,
            mediaType: item.mediaType
          };
          
          // Only embed small images (< 100KB)
          if (imageSize < 100000) {
            imageResource.base64 = `data:${item.mediaType};base64,${imageData}`;
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
        const cssFile = zip.files[cssPath];
        
        if (cssFile) {
          const cssContent = await cssFile.async('text');
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
  
  return resources;
}

// Main EPUB parsing function
async function parseEpubContent(epubData: Uint8Array, filename: string): Promise<EpubContent> {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  console.log(`Starting EPUB parsing for: ${filename}`);
  
  try {
    // Load ZIP file
    const zip = await JSZip.loadAsync(epubData);
    console.log(`EPUB ZIP loaded successfully, contains ${Object.keys(zip.files).length} files`);
    
    // Find container.xml
    const containerFile = zip.files['META-INF/container.xml'];
    if (!containerFile) {
      throw new Error('Invalid EPUB: META-INF/container.xml not found');
    }
    
    // Parse container.xml to find package document
    const containerXml = await containerFile.async('text');
    const packagePath = extractPackagePath(containerXml);
    console.log(`Found package document at: ${packagePath}`);
    
    // Load and parse package document
    const packageFile = zip.files[packagePath];
    if (!packageFile) {
      throw new Error(`Package document not found at: ${packagePath}`);
    }
    
    const packageXml = await packageFile.async('text');
    const packageData = parsePackageDocument(packageXml);
    console.log(`Parsed package document, found ${packageData.spine.length} spine items`);
    
    // Parse navigation document if available
    let tableOfContents: TocEntry[] = [];
    try {
      const navItem = packageData.manifest.find((item: any) => 
        item.properties?.includes('nav') || item.mediaType === 'application/xhtml+xml'
      );
      
      if (navItem) {
        const navPath = resolveHref(packagePath, navItem.href);
        const navFile = zip.files[navPath];
        if (navFile) {
          const navContent = await navFile.async('text');
          tableOfContents = parseNavigationDocument(navContent);
          console.log(`Parsed navigation document, found ${tableOfContents.length} TOC entries`);
        }
      }
    } catch (error) {
      warnings.push(`Failed to parse navigation: ${error.message}`);
      console.warn(`Navigation parsing warning: ${error.message}`);
    }
    
    // Process chapters from spine
    const chapters: Chapter[] = [];
    let totalWordCount = 0;
    
    for (let i = 0; i < packageData.spine.length; i++) {
      const spineItem = packageData.spine[i];
      try {
        const manifestItem = packageData.manifest.find((item: any) => item.id === spineItem.idref);
        if (!manifestItem) {
          warnings.push(`Spine item ${spineItem.idref} not found in manifest`);
          continue;
        }
        
        const chapterPath = resolveHref(packagePath, manifestItem.href);
        const chapterFile = zip.files[chapterPath];
        
        if (!chapterFile) {
          warnings.push(`Chapter file not found: ${chapterPath}`);
          continue;
        }
        
        const htmlContent = await chapterFile.async('text');
        const textContent = extractTextFromHtml(htmlContent);
        const wordCount = countWords(textContent);
        totalWordCount += wordCount;
        
        // Extract chapter title from HTML or use manifest title
        const title = extractChapterTitle(htmlContent) || manifestItem.id || `Chapter ${i + 1}`;
        
        chapters.push({
          id: manifestItem.id,
          title: title,
          href: manifestItem.href,
          htmlContent: htmlContent,
          textContent: textContent,
          wordCount: wordCount,
          order: i,
          level: 1
        });
        
        console.log(`Processed chapter ${i + 1}: "${title}" (${wordCount} words)`);
      } catch (error) {
        warnings.push(`Failed to process chapter ${i}: ${error.message}`);
        console.warn(`Chapter processing warning: ${error.message}`);
      }
    }
    
    // Process resources (images, stylesheets, fonts)
    const resources = await processEpubResources(zip, packageData.manifest, packagePath);
    
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
        spine: packageData.spine.map((item: any) => ({
          id: item.idref,
          href: packageData.manifest.find((m: any) => m.id === item.idref)?.href || '',
          mediaType: packageData.manifest.find((m: any) => m.id === item.idref)?.mediaType || 'application/xhtml+xml',
          linear: item.linear !== 'no',
          properties: packageData.manifest.find((m: any) => m.id === item.idref)?.properties
        }))
      },
      chapters: chapters,
      resources: resources,
      parsing: {
        parsedAt: new Date().toISOString(),
        epubVersion: packageData.version || '3.0',
        parser: 'supabase-epub-parser-v2.0',
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined
      }
    };
    
    console.log(`EPUB parsing completed successfully for ${filename}`);
    console.log(`- ${chapters.length} chapters processed`);
    console.log(`- ${totalWordCount} total words`);
    console.log(`- ${estimatedReadingTime} minutes estimated reading time`);
    console.log(`- ${warnings.length} warnings, ${errors.length} errors`);
    
    return epubContent;
    
  } catch (error) {
    console.error(`EPUB parsing failed for ${filename}:`, error);
    throw new Error(`EPUB parsing failed: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    });
  }

  try {
    const body = await req.json();
    const { data, filename } = body;
    
    if (!data || !filename) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: data, filename' }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    // Convert base64 back to Uint8Array
    const epubData = new Uint8Array(atob(data).split('').map(char => char.charCodeAt(0)));
    
    console.log(`Starting EPUB content parsing for: ${filename}`);
    const startTime = Date.now();
    
    // Parse EPUB content
    const epubContent = await parseEpubContent(epubData, filename);
    const parseTime = Date.now() - startTime;
    
    return new Response(
      JSON.stringify({
        success: true,
        filename: filename,
        parseTime: parseTime,
        content: epubContent,
        summary: {
          title: epubContent.metadata.title,
          author: epubContent.metadata.author,
          chapters: epubContent.structure.totalChapters,
          words: epubContent.structure.wordCount,
          readingTime: epubContent.structure.estimatedReadingTime,
          coverFound: !!epubContent.resources.coverImage,
          errors: epubContent.parsing.errors?.length || 0,
          warnings: epubContent.parsing.warnings?.length || 0
        }
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );

  } catch (error) {
    console.error('Error in parse-epub-content function:', error);
    return new Response(
      JSON.stringify({ 
        error: error.message || 'EPUB parsing failed',
        hint: 'Check that the EPUB file structure is valid and contains readable content'
      }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
});
