// ============================================================
//  CONFIGURACIÓN DE RUTACUADRE
//  Pega aquí la configuración de tu proyecto de Firebase.
//  La encuentras en: Consola de Firebase > Configuración del proyecto
//  > General > Tus apps > App web > "Configuración del SDK".
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyCcQUD1OlGX3jgGbI4PIR1nfIKXCXiiOuU",
  authDomain: "rutacuadre.firebaseapp.com",
  projectId: "rutacuadre",
  storageBucket: "rutacuadre.firebasestorage.app",
  messagingSenderId: "953488376611",
  appId: "1:953488376611:web:051207109cd2fd77558296"
};

// Dominio interno para los usuarios. Los conductores entran con usuario y clave;
// la app convierte el usuario en un correo interno (usuario@DOMINIO). No se envían correos.
export const DOMINIO_USUARIOS = "rutacuadre.local";

// Solo para pruebas con el emulador de Firebase en tu computador. Déjalo en false.
export const USAR_EMULADOR = false;
