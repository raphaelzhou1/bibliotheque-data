// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "@supabase/supabase-js"
import JSZip from "jszip"

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

// Helper function to sanitize filename for storage
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9\-_.]/g, '_') // Replace special chars with underscore
    .replace(/_{2,}/g, '_') // Replace multiple underscores with single
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .replace(" ", '') // Remove leading/trailing underscores
    .toLowerCase();
}

// Helper function to extract text content from HTML
function extractTextFromHtml(htmlContent: string): string {
  // Basic HTML tag removal - can be enhanced with a proper HTML parser
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

// EPUB Parsing Functions
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
      const navItem = packageData.manifest.find(item => 
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
        const manifestItem = packageData.manifest.find(item => item.id === spineItem.idref);
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
        parser: 'supabase-epub-parser-v1.0',
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

// Helper functions for XML parsing
function extractPackagePath(containerXml: string): string {
  const match = containerXml.match(/full-path=["']([^"']+)["']/);
  if (!match) {
    throw new Error('Package path not found in container.xml');
  }
  return match[1];
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

function parsePackageDocument(packageXml: string) {
  // Basic XML parsing - extract metadata, manifest, and spine
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
  
  // Parse spine items
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

function parseNavigationDocument(navContent: string): TocEntry[] {
  // Basic TOC extraction from navigation document
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
  // Try to extract title from h1, h2, or title tags
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
  // Simple path resolution
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
          // For small images, convert to base64
          const imageData = await imageFile.async('base64');
          const imageSize = imageData.length * 0.75; // Approximate size in bytes
          
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

console.log("Add new book function loaded!")

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
          const zip = await JSZip.loadAsync(uint8Array)
          
          // Find EPUB files in the ZIP
          const epubFiles = Object.keys(zip.files).filter(filename => 
            filename.endsWith('.epub') && !zip.files[filename].dir
          )
          
          if (epubFiles.length === 0) {
            throw new Error(`No EPUB files found in ${file.name}`)
          }
          
          if (epubFiles.length > 1) {
            console.warn(`Multiple EPUB files found in ${file.name}, using first one: ${epubFiles[0]}`)
          }
          
          const epubFilename = epubFiles[0]
          const epubFile = zip.files[epubFilename]
          const epubData = await epubFile.async('uint8array')
          
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
