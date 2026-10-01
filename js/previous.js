// Typewriter Effect
const typewriterText = "Previous Meeting Links";
const typewriterElement = document.getElementById("typewriter");
let index = 0;

function typeWriter() {
  if (!typewriterElement) return; // Prevent errors if element is missing
  if (index < typewriterText.length) {
    typewriterElement.textContent = typewriterText.slice(0, index + 1);
    index++;
    setTimeout(typeWriter, 100);
  }
}

// Subtitle Cycling
const subtitles = [
  "Look At the Past Meetings!",
  "In case you missed anything",
  "Record Keeping!"
];
let subtitleIndex = 0;
const subtitleElement = document.getElementById("subtitle");

function cycleSubtitles() {
  if (!subtitleElement) return; // Prevent errors if element is missing
  subtitleElement.classList.remove("fade-in");
  setTimeout(() => {
    subtitleElement.textContent = subtitles[subtitleIndex];
    subtitleElement.classList.add("fade-in");
    subtitleIndex = (subtitleIndex + 1) % subtitles.length;
  }, 500);
}

// Gallery Slide Navigation
let currentSlide = 0;
const slides = document.querySelectorAll('.gallery-item');

function showSlide(index) {
  document.getElementById('slide-counter').textContent = `Presentation ${index + 1} of ${slides.length}`;
  document.getElementById('previous-slide').disabled = slides.length <= 1;
  document.getElementById('next-slide').disabled = slides.length <= 1;
  slides.forEach((slide, i) => {
    slide.style.display = i === index ? 'block' : 'none';
  });
}

function nextSlide() {
  currentSlide = (currentSlide + 1) % slides.length;
  showSlide(currentSlide);
}

function prevSlide() {
  currentSlide = (currentSlide - 1 + slides.length) % slides.length;
  showSlide(currentSlide);
}

// Menu Toggle
const menuToggle = document.querySelector('.menu-toggle');
const nav = document.getElementById('nav-menu');

function toggleMenu() {
  if (nav) {
    nav.classList.toggle('show');
  }
}

// Scroll Arrow
const scrollArrow = document.getElementById('scroll-arrow');
const heroSection = document.getElementById('hero');

function handleScrollArrow() {
  window.scrollBy({
    top: window.innerHeight,
    behavior: 'smooth'
  });
}

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (scrollArrow) {
      scrollArrow.style.opacity = entry.isIntersecting ? '1' : '0';
    }
  });
}, {
  root: null,
  threshold: 0.1
});

// Initialize Everything
document.addEventListener("DOMContentLoaded", () => {
  // Typewriter
  typeWriter();

  // Subtitle Cycling
  cycleSubtitles();
  setInterval(cycleSubtitles, 4000);

  // Gallery
  showSlide(currentSlide);

  // Menu Toggle
  if (menuToggle) {
    menuToggle.addEventListener('click', toggleMenu);
  }

  // Scroll Arrow
  if (scrollArrow) {
    scrollArrow.addEventListener('click', handleScrollArrow);
  }
  if (heroSection) {
    observer.observe(heroSection);
  }
});