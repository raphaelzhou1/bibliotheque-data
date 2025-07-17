// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import JSZip from "jszip"

interface ProcessedFile {
  data: Uint8Array;
  filename: string;
  originalSize: number;
  compressedSize: number;
  isValid: boolean;
  errors?: string[];
}

// Helper function to sanitize filename for storage
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9\-_.]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(" ", '')
    .toLowerCase();
}

// Validate EPUB structure
async function validateEpubStructure(epubData: Uint8Array): Promise<{ isValid: boolean; errors: string[] }> {
  const errors: string[] = [];
  
  try {
    const zip = await JSZip.loadAsync(epubData);
    
    // Check for required files
    if (!zip.files['META-INF/container.xml']) {
      errors.push('Missing META-INF/container.xml - not a valid EPUB');
    }
    
    // Check mimetype file
    const mimetypeFile = zip.files['mimetype'];
    if (mimetypeFile) {
      const mimetype = await mimetypeFile.async('text');
      if (mimetype.trim() !== 'application/epub+zip') {
        errors.push('Invalid mimetype - should be application/epub+zip');
      }
    }
    
    // Basic structure validation
    const fileCount = Object.keys(zip.files).length;
    if (fileCount < 3) {
      errors.push('EPUB appears to be incomplete - too few files');
    }
    
    return { isValid: errors.length === 0, errors };
  } catch (error) {
    return { isValid: false, errors: [`Failed to read EPUB structure: ${error.message}`] };
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
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const expectedSide = formData.get('side') as 'foreign' | 'native';
    
    if (!file) {
      return new Response(
        JSON.stringify({ error: 'No file provided' }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    console.log(`Processing ${expectedSide} file: ${file.name} (${file.size} bytes)`);
    
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    let processedFile: ProcessedFile;
    
    // Check if it's a ZIP file
    if (file.name.endsWith('.zip') || file.type === 'application/zip') {
      console.log(`Decompressing ZIP file: ${file.name}`);
      
      try {
        const zip = await JSZip.loadAsync(uint8Array);
        
        // Find EPUB files in the ZIP
        const epubFiles = Object.keys(zip.files).filter(filename => 
          filename.endsWith('.epub') && !zip.files[filename].dir
        );
        
        if (epubFiles.length === 0) {
          throw new Error(`No EPUB files found in ${file.name}`);
        }
        
        if (epubFiles.length > 1) {
          console.warn(`Multiple EPUB files found in ${file.name}, using first one: ${epubFiles[0]}`);
        }
        
        const epubFilename = epubFiles[0];
        const epubFile = zip.files[epubFilename];
        const epubData = await epubFile.async('uint8array');
        
        console.log(`Extracted ${epubFilename} from ZIP: ${epubData.length} bytes (was ${file.size} bytes compressed)`);
        
        // Validate extracted EPUB
        const validation = await validateEpubStructure(epubData);
        
        processedFile = {
          data: epubData,
          filename: epubFilename,
          originalSize: epubData.length,
          compressedSize: file.size,
          isValid: validation.isValid,
          errors: validation.errors.length > 0 ? validation.errors : undefined
        };
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            error: `Failed to decompress ZIP file ${file.name}: ${error.message}`,
            hint: 'Ensure the ZIP file contains valid EPUB files'
          }),
          { 
            status: 400,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          }
        );
      }
    } else if (file.name.endsWith('.epub')) {
      // Direct EPUB file
      console.log(`Processing direct EPUB file: ${file.name}`);
      
      // Validate EPUB structure
      const validation = await validateEpubStructure(uint8Array);
      
      processedFile = {
        data: uint8Array,
        filename: file.name,
        originalSize: file.size,
        compressedSize: file.size,
        isValid: validation.isValid,
        errors: validation.errors.length > 0 ? validation.errors : undefined
      };
    } else {
      return new Response(
        JSON.stringify({ 
          error: `Unsupported file type: ${file.name}. Only EPUB and ZIP files are supported.`,
          hint: 'Please upload a .epub file or a .zip file containing EPUB files'
        }),
        { 
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    // Return processed file info
    return new Response(
      JSON.stringify({
        success: true,
        filename: processedFile.filename,
        sanitizedFilename: sanitizeFilename(processedFile.filename),
        originalSize: processedFile.originalSize,
        compressedSize: processedFile.compressedSize,
        compressionRatio: ((processedFile.compressedSize / processedFile.originalSize) * 100).toFixed(1) + '%',
        isValid: processedFile.isValid,
        errors: processedFile.errors,
        warnings: processedFile.errors && processedFile.errors.length > 0 ? 
          ['File has validation issues but will be processed'] : undefined,
        // Return the processed data as base64 for transfer to next function
        data: btoa(String.fromCharCode(...processedFile.data))
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );

  } catch (error) {
    console.error('Error in process-epub-file function:', error);
    return new Response(
      JSON.stringify({ 
        error: error.message || 'An unexpected error occurred',
        hint: 'Check that the file is a valid EPUB or ZIP containing EPUBs'
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
